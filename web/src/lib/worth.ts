import type { RuneLadder } from "@/app/rune-price";
import { query } from "@/lib/db";
import { allMarks, mode, threshold, type Status } from "@/lib/verdict";
import { fetchRecipe, latestLadders, loadItem } from "@/lib/breaker";
import { planBuy } from "@/lib/craft";

export interface WorthRow {
  itemId: number;
  name: string;
  level: number | null;
  type: string | null;
  /** Kamas one crush yields, the better of focusing and not. Null when unpriced. */
  value: number | null;
  /** What a copy costs: cheapest listing, else the last stack quote. */
  cost: number | null;
  /** Against the cheaper of buying and crafting. Null when neither is known. */
  profit: number | null;
  /** Which side that was, so the row can say what it measured against. */
  against: "market" | "craft" | null;
  /** What the ingredients cost, or null with no recipe or an unpriced one. */
  craft: number | null;
  /** The rune worth focusing, or null when crushing plain wins. */
  focus: string | null;
  /** That rune's batch ladder, for the hover. Null when none was captured. */
  focusLadder: RuneLadder | null;
  /** The rune's own item id, so its price history is one click away. */
  focusItemId: number | null;
  /** True when a crush of this item fixed the coefficient; false when assumed. */
  observed: boolean;
  coefficient: number;
  /**
   * When that crush happened, ISO — the reading's age, which is the thing that
   * decides whether the coefficient is still worth believing. Null when no
   * crush of this item was ever captured. A string rather than a Date so it
   * crosses into the client component that sorts on it.
   */
  crushedAt: string | null;
  status: Status;
  manual: boolean;
}

/**
 * The items you have marked, ranked by profit.
 *
 * Under Automatic, anything clearing the threshold is here, and your marks
 * override it either way — a Skip you set hides an item the arithmetic likes,
 * and a Worth it keeps one it does not. Under Manual nothing is judged and the
 * list is your marks alone, which is what that mode is for.
 *
 * Rejections are only ever listed when *you* made them. Under Automatic
 * everything below the bar is "not worth breaking", and a list of every item
 * the threshold declined is not a list anybody reads.
 *
 * One query rather than a page-load each: the per-item page assembles a dozen
 * round trips and a DofusDB call, which is right for one item and hopeless for
 * two hundred.
 *
 * Valued for an average copy, from the item type's template, and from the last
 * copy you held only where no template covers it. Same basis as the badge and
 * the card, deliberately: the question is whether the item is worth buying to
 * break, and the copy in your hands is one sample of what you would be buying.
 *
 * It does mean a good roll reads lower here than it did in your hands —
 * Médaille Holy was +17.6% as the copy you broke and +12.5% as a template. The
 * first is what you got; the second is what the next one is worth.
 *
 * The coefficient is per item and mostly unobserved, so items without a crush
 * are computed at 100% and flagged. That is a placeholder, not a ceiling: real
 * crushes have come back at 126% and 143%, so an assumed row can understate as
 * easily as overstate.
 */
export async function judgeItems(itemIds: number[]): Promise<{
  rows: WorthRow[];
  automatic: boolean;
  thresholdPercent: number;
}> {
  const [marks, current, thresholdPercent] = await Promise.all([
    allMarks(),
    mode(),
    threshold(),
  ]);
  const automatic = current === "automatic";
  // Your marks belong on the list whatever the catalogue holds: an item marked
  // before anything ever named it is exactly the row that would go missing.
  const wanted = [...new Set([...itemIds, ...marks.keys()])];
  if (wanted.length === 0) return { rows: [], automatic, thresholdPercent };

  const rows = await query<{
    item_id: string;
    name_fr: string | null;
    level: number | null;
    type_fr: string | null;
    value: string;
    cost: string;
    focus_rune: string | null;
    coefficient: string;
    observed: boolean;
    crushed_at: Date | null;
  }>(
    `WITH candidates AS (
       -- Whatever the caller asked about. It used to pick its own candidates
       -- from every table that has ever named an item, which is the same set
       -- the catalogue now hands in — and being told means the list and its
       -- economics can never disagree about which items exist.
       SELECT item_id FROM unnest($1::bigint[]) AS t(item_id)
     ),
     coef AS (
       SELECT DISTINCT ON (item_id) item_id, yield_percent, seen_at
         FROM crushes WHERE item_id IS NOT NULL
        ORDER BY item_id, seen_at DESC
     ),
     rune_price AS (
       SELECT DISTINCT ON (item_id) item_id, b1
         FROM prices WHERE b1 > 0
        ORDER BY item_id, seen_at DESC
     ),
     -- Cheapest listing in the newest snapshot for that item; the window keeps
     -- one panel's worth together, since every offer in it lands at once.
     offer_cost AS (
       SELECT o.item_id, min(o.price) AS cost
         FROM offers o
         JOIN (SELECT item_id, max(seen_at) AS newest FROM offers GROUP BY 1) n
           ON n.item_id = o.item_id AND o.seen_at >= n.newest - interval '10 seconds'
        GROUP BY o.item_id
     ),
     stack_cost AS (
       SELECT DISTINCT ON (item_id) item_id, b1 AS cost
         FROM prices WHERE b1 > 0
        ORDER BY item_id, seen_at DESC
     ),
     -- What the copy you last held actually rolled. Preferred over the
     -- template wherever it exists: an item you broke is not a hypothetical
     -- average one, and judging it as though it were disagrees with its own
     -- page over the same item. line_weight is docs/brisage-model.md's, the
     -- trailing +1 included.
     latest_instance AS (
       SELECT DISTINCT ON (item_id) item_id, uid
         FROM item_stats ORDER BY item_id, seen_at DESC
     ),
     instance_lines AS (
       SELECT s.item_id, r.rune, r.rune_weight,
              3 * s.value * r.rune_weight / r.stat_per_rune * i.level / 200.0 + 1
                AS weight,
              rp.b1 AS unit_price, COALESCE(c.yield_percent, 100) AS coefficient,
              c.yield_percent IS NOT NULL AS observed
         FROM item_stats s
         JOIN latest_instance li ON li.uid = s.uid
         JOIN runes r ON r.effect_id = s.effect_id
         JOIN items i ON i.item_id = s.item_id
         LEFT JOIN rune_price rp ON rp.item_id = r.item_id
         LEFT JOIN coef c ON c.item_id = s.item_id
     ),
     template_lines AS (
       SELECT w.item_id, w.rune, w.rune_weight, w.avg_line_weight AS weight,
              rp.b1 AS unit_price, COALESCE(c.yield_percent, 100) AS coefficient,
              c.yield_percent IS NOT NULL AS observed
         FROM item_effect_weights w
         JOIN runes r ON r.effect_id = w.effect_id
         LEFT JOIN rune_price rp ON rp.item_id = r.item_id
         LEFT JOIN coef c ON c.item_id = w.item_id
     ),
     -- Template first, instance only where no template covers the item. This
     -- is the basis the card and the badge speak in, and the one the projection
     -- table opens on: whether the *item* is worth breaking, not what one copy
     -- rolled. Three screens agreeing beats any of them being individually
     -- defensible — they were disagreeing in both directions within a day.
     lines AS (
       SELECT * FROM template_lines
       UNION ALL
       SELECT * FROM instance_lines i
        WHERE NOT EXISTS (SELECT 1 FROM template_lines t WHERE t.item_id = i.item_id)
     ),
     totals AS (SELECT item_id, sum(weight) AS total FROM lines GROUP BY 1),
     -- Crushing plain: every line yields its own rune. Only counted when every
     -- line is priced, for the same reason a partial craft cost is refused.
     no_focus AS (
       SELECT l.item_id,
              sum(l.weight / l.rune_weight * l.coefficient / 100 * l.unit_price) AS value,
              bool_and(l.unit_price IS NOT NULL) AS priced
         FROM lines l GROUP BY l.item_id
     ),
     -- Focusing: half the focused line plus half of everything, into one rune.
     best_focus AS (
       SELECT DISTINCT ON (l.item_id) l.item_id, l.rune,
              (l.weight / 2 + t.total / 2) / l.rune_weight * l.coefficient / 100
                * l.unit_price AS value
         FROM lines l JOIN totals t ON t.item_id = l.item_id
        WHERE l.unit_price IS NOT NULL
        ORDER BY l.item_id, 3 DESC
     )
     -- Driven by your marks, LEFT JOINed to everything else: an item you
     -- marked before the importer ever saw it still belongs on your list, and
     -- starting from the items table silently dropped exactly those.
     SELECT m.item_id, i.name_fr, i.level, i.type_fr,
            GREATEST(COALESCE(nf.value, 0), COALESCE(bf.value, 0)) AS value,
            COALESCE(oc.cost, sc.cost) AS cost,
            CASE WHEN COALESCE(bf.value, 0) > COALESCE(nf.value, 0)
                 THEN bf.rune END AS focus_rune,
            COALESCE(cf.yield_percent, 100) AS coefficient,
            cf.yield_percent IS NOT NULL AS observed,
            cf.seen_at AS crushed_at
       FROM candidates AS m(item_id)
       LEFT JOIN items i ON i.item_id = m.item_id
       LEFT JOIN no_focus nf ON nf.item_id = m.item_id AND nf.priced
       LEFT JOIN best_focus bf ON bf.item_id = m.item_id
       LEFT JOIN offer_cost oc ON oc.item_id = m.item_id
       LEFT JOIN stack_cost sc ON sc.item_id = m.item_id
       LEFT JOIN coef cf ON cf.item_id = m.item_id`,
    [wanted],
  );

  const out: WorthRow[] = [];
  for (const r of rows) {
    const itemId = Number(r.item_id);
    const marked = marks.get(itemId) ?? null;
    // Without a crush of this item there is no coefficient, and every rune
    // figure is a multiple of it. The SQL computes those at 100% so the columns
    // line up; ranking by them would be ranking by a placeholder, and a real
    // coefficient is anywhere from 16% to 150% in this capture. No reading, no
    // figure.
    const observed = r.observed;
    const raw = r.value === null || Number(r.value) === 0 ? null : Number(r.value);
    const value = observed ? raw : null;
    const cost = r.cost === null || Number(r.cost) === 0 ? null : Number(r.cost);
    out.push({
      itemId,
      name: r.name_fr ?? `Item ${itemId}`,
      level: r.level,
      type: r.type_fr,
      value,
      cost,
      profit: null,
      against: null,
      craft: null,
      focus: observed ? r.focus_rune : null,
      focusLadder: null,
      focusItemId: null,
      observed,
      coefficient: Number(r.coefficient),
      crushedAt: r.crushed_at === null ? null : r.crushed_at.toISOString(),
      status: marked ?? "skip",
      manual: marked !== null,
    });
  }

  // Unpriced last: they are on the list because you put them there, but they
  // cannot be ranked against the ones the market has an opinion about.
  for (const [itemId, craft] of await craftCosts(out.map((r) => r.itemId))) {
    const row = out.find((r) => r.itemId === itemId);
    if (row) row.craft = craft;
  }

  for (const row of out) price(row);

  await fillFromInstances(out);

  // The verdict, once every figure is in: a mark if you set one, else the
  // threshold under Automatic. Every row is returned and labelled rather than
  // filtered — the page decides what to show, and it wants to show the rows
  // that fell short too.
  const judged = out;
  for (const row of judged) {
    if (row.manual) continue;
    row.status =
      automatic && row.profit !== null && row.profit >= thresholdPercent
        ? "worth"
        : "skip";
  }

  // Ladders for the runes that survived, so hovering one says what it sells
  // for. Only the focus runes, and only on the rows being shown.
  for (const [rune, found] of await runeLadders(
    judged.map((r) => r.focus).filter((f): f is string => f !== null),
  )) {
    for (const row of judged) {
      if (row.focus !== rune) continue;
      row.focusLadder = found.ladder;
      row.focusItemId = found.itemId;
    }
  }

  judged.sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
  return { rows: judged, automatic, thresholdPercent };
}

/**
 * Profit against the cheaper of buying a copy and making one.
 *
 * Those are the two ways to get the item, and you would take the cheaper — so
 * measuring against the market price alone overstates the case for breaking
 * anything cheaper to craft, which is most crafted gear.
 */
function price(row: WorthRow): void {
  const options: [number, "market" | "craft"][] = [];
  if (row.cost !== null) options.push([row.cost, "market"]);
  if (row.craft !== null) options.push([row.craft, "craft"]);
  if (row.value === null || options.length === 0) {
    row.profit = null;
    row.against = null;
    return;
  }
  const [cheapest, against] = options.reduce((a, b) => (b[0] < a[0] ? b : a));
  row.profit = (row.value * 100) / cheapest - 100;
  row.against = against;
}

/**
 * What each item costs to craft, by the same batch maths the item page uses.
 *
 * Computed in TypeScript rather than SQL so it reuses `planBuy` verbatim: the
 * mixed-fill rule and its 30% tolerance are the kind of thing that drifts the
 * moment there are two copies of it, and the list is only ever as long as your
 * marks.
 *
 * Null for an item with no recipe, and for one whose ingredients are not all
 * priced — a sum over the ingredients that happen to be on the market is not a
 * cheaper craft, it is a wrong one.
 */
/**
 * The batch ladder behind each named rune.
 *
 * Two hops, because a rune is a row in `runes` keyed by effect and an item id
 * on the market: name -> item id -> the newest ladder quoted for it. A rune
 * nobody has browsed simply has none.
 */
async function runeLadders(
  names: string[],
): Promise<Map<string, { itemId: number; ladder: RuneLadder | null }>> {
  const out = new Map<string, { itemId: number; ladder: RuneLadder | null }>();
  const wanted = [...new Set(names)];
  if (wanted.length === 0) return out;
  const rows = await query<{ rune: string; item_id: string }>(
    `SELECT DISTINCT rune, item_id FROM runes
      WHERE rune = ANY($1::text[]) AND item_id IS NOT NULL`,
    [wanted],
  );
  const ladders = await latestLadders(rows.map((r) => Number(r.item_id)));
  for (const row of rows) {
    const itemId = Number(row.item_id);
    const ladder = ladders.get(itemId);
    // The id is worth returning even with no ladder: the rune has a history
    // page either way, and an empty one says "never seen on the market".
    out.set(row.rune, {
      itemId,
      ladder: ladder ? [ladder.b1, ladder.b10, ladder.b100, ladder.b1000] : null,
    });
  }
  return out;
}

async function craftCosts(itemIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (itemIds.length === 0) return out;

  const rows = await query<{ item_id: string; ingredient_id: string; quantity: number }>(
    `SELECT item_id, ingredient_id, quantity FROM recipes
      WHERE item_id = ANY($1::bigint[]) ORDER BY item_id, position`,
    [itemIds],
  );

  const byItem = new Map<number, { ingredientId: number; quantity: number }[]>();
  for (const r of rows) {
    const itemId = Number(r.item_id);
    const list = byItem.get(itemId) ?? [];
    list.push({ ingredientId: Number(r.ingredient_id), quantity: r.quantity });
    byItem.set(itemId, list);
  }

  // The same DofusDB fallback the item page uses, or a marked item the importer
  // has not reached shows "no recipe" here while its own page prices the craft
  // happily — two screens disagreeing about the same item.
  // Capped: this is one request per item, and the catalogue is hundreds of
  // items deep now. The ones with no recipe row are mostly drop-only gear that
  // has no recipe at all, so the budget goes on the first few and the rest
  // read as "no craft" until the importer or a job load reaches them.
  const missing = itemIds.filter((id) => !byItem.has(id)).slice(0, 40);
  for (const id of missing) {
    const recipe = await fetchRecipe(id);
    if (recipe === null) continue;
    byItem.set(
      id,
      recipe.map((r) => ({ ingredientId: r.itemId, quantity: r.quantity })),
    );
  }
  if (byItem.size === 0) return out;

  const ladders = await latestLadders(
    [...byItem.values()].flat().map((i) => i.ingredientId),
  );

  for (const [itemId, ingredients] of byItem) {
    let total = 0;
    let priced = true;
    for (const ing of ingredients) {
      const ladder = ladders.get(ing.ingredientId);
      const plan = ladder ? planBuy(ing.quantity, ladder) : null;
      if (!plan) {
        priced = false;
        break;
      }
      total += plan.cost;
    }
    if (priced) out.set(itemId, total);
  }
  return out;
}

/**
 * Value the rows the template could not.
 *
 * The bulk query reads `item_effect_weights`, which exists only for items
 * `tools/import_items.py` has enriched. An item you broke yesterday may have no
 * template at all — and yet the wire gave its real stat lines, its level came
 * back from DofusDB, and a crush of it fixed the coefficient. Everything needed
 * is there; only the offline table is missing.
 *
 * So those rows go through `loadItem`, the same loader the item page uses. It
 * costs a handful of round trips each, which the marked list can afford, and it
 * guarantees the two screens agree rather than merely intending to.
 *
 * Capped, because "a handful each" stops being affordable somewhere, and a
 * marked list that grows to hundreds should degrade by showing dashes rather
 * than by taking a second to load.
 */
async function fillFromInstances(rows: WorthRow[]): Promise<void> {
  // Only rows with a real coefficient — without one the value is withheld
  // anyway — and the ones that can produce a profit first: a row with neither a
  // market price nor a recipe cannot be judged however well it is valued, so it
  // should not be what uses up the budget. Médaille Holy sat past a cap of 25
  // and was simply missing from the list while its own page judged it fine.
  const needing = rows
    .filter((r) => r.value === null && r.observed)
    .sort(
      (a, b) =>
        Number(b.cost !== null || b.craft !== null) -
        Number(a.cost !== null || a.craft !== null),
    )
    .slice(0, 80);
  await Promise.all(
    needing.map(async (row) => {
      const view = await loadItem(row.itemId);
      if (!view) return;

      // Column 1 is the coefficient in force; column 0 is the 100% reference.
      const focus = view.outcomes[0]?.value[1] ?? null;
      const none = view.noFocus.value[1] ?? null;
      if (focus === null && none === null) return;

      const best = Math.max(focus ?? 0, none ?? 0);
      if (best <= 0) return;

      row.cost = row.cost ?? view.projection.itemCost;
      row.craft = row.craft ?? view.projection.craft?.cost ?? null;
      row.coefficient = view.coefficient;
      row.observed = !view.projection.coefficientAssumed;
      // Same rule as the bulk path: a yield computed at an assumed coefficient
      // is not a yield. The cost columns stand on their own and stay.
      if (row.observed) {
        row.value = best;
        row.focus = (focus ?? 0) >= (none ?? 0) ? (view.outcomes[0]?.rune ?? null) : null;
      }
      price(row);
    }),
  );
}
