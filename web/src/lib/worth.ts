import { query } from "@/lib/db";
import { allMarks, type Status } from "@/lib/verdict";
import { fetchItems, fetchRecipe, latestLadders } from "@/lib/breaker";
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
  /** Null whenever either side of the sum is missing. */
  profit: number | null;
  /** What the ingredients cost, or null with no recipe or an unpriced one. */
  craft: number | null;
  /** The rune worth focusing, or null when crushing plain wins. */
  focus: string | null;
  /** True when a crush of this item fixed the coefficient; false when assumed. */
  observed: boolean;
  coefficient: number;
  status: Status;
  manual: boolean;
}

/**
 * The items you have marked, ranked by profit.
 *
 * Membership is your marks and nothing else. The automatic verdict decides what
 * the badge on an item's page says; it does not put items in this list, because
 * a list you curate and a list a threshold generates are different tools and
 * mixing them means neither can be trusted at a glance.
 *
 * One query rather than a page-load each: the per-item page assembles a dozen
 * round trips and a DofusDB call, which is right for one item and hopeless for
 * two hundred.
 *
 * **Estimated for an average copy.** Weights come from `item_effect_weights` —
 * the middle of each template range — not from an instance you happen to have
 * held. That is the correct basis for "which items are worth buying to break",
 * and it means a listed figure can differ from the same item's page when that
 * page is describing a specific copy. The page is authoritative for the copy;
 * this is authoritative for the item type.
 *
 * The coefficient is per item and mostly unobserved, so items without a crush
 * are computed at 100% and flagged. That is a placeholder, not a ceiling: real
 * crushes have come back at 126% and 143%, so an assumed row can understate as
 * easily as overstate.
 */
export async function worthList(): Promise<{ rows: WorthRow[] }> {
  const marks = await allMarks();
  if (marks.size === 0) return { rows: [] };

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
  }>(
    `WITH coef AS (
       SELECT DISTINCT ON (item_id) item_id, yield_percent
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
     lines AS (
       SELECT w.item_id, w.rune, w.rune_weight, w.avg_line_weight AS weight,
              rp.b1 AS unit_price, COALESCE(c.yield_percent, 100) AS coefficient,
              c.yield_percent IS NOT NULL AS observed
         FROM item_effect_weights w
         JOIN runes r ON r.effect_id = w.effect_id
         LEFT JOIN rune_price rp ON rp.item_id = r.item_id
         LEFT JOIN coef c ON c.item_id = w.item_id
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
            cf.yield_percent IS NOT NULL AS observed
       FROM unnest($1::bigint[]) AS m(item_id)
       LEFT JOIN items i ON i.item_id = m.item_id
       LEFT JOIN no_focus nf ON nf.item_id = m.item_id AND nf.priced
       LEFT JOIN best_focus bf ON bf.item_id = m.item_id
       LEFT JOIN offer_cost oc ON oc.item_id = m.item_id
       LEFT JOIN stack_cost sc ON sc.item_id = m.item_id
       LEFT JOIN coef cf ON cf.item_id = m.item_id`,
    [[...marks.keys()]],
  );

  const out: WorthRow[] = [];
  for (const r of rows) {
    const itemId = Number(r.item_id);
    const status = marks.get(itemId) ?? null;
    if (status === null) continue;
    // A zero means no line of this item could be priced — the template is not
    // imported, or a rune it yields has never been on the market. That is
    // unknown, not worthless, and "0 k" beside "-100%" reads as the latter.
    const value = r.value === null || Number(r.value) === 0 ? null : Number(r.value);
    const cost = r.cost === null || Number(r.cost) === 0 ? null : Number(r.cost);
    const profit = value === null || cost === null ? null : (value * 100) / cost - 100;

    out.push({
      itemId,
      name: r.name_fr ?? `Item ${itemId}`,
      level: r.level,
      type: r.type_fr,
      value,
      cost,
      profit,
      craft: null,
      focus: r.focus_rune,
      observed: r.observed,
      coefficient: Number(r.coefficient),
      status,
      manual: true,
    });
  }

  // Unpriced last: they are on the list because you put them there, but they
  // cannot be ranked against the ones the market has an opinion about.
  for (const [itemId, craft] of await craftCosts(out.map((r) => r.itemId))) {
    const row = out.find((r) => r.itemId === itemId);
    if (row) row.craft = craft;
  }

  // Names for ids the importer has never reached — they are on the list
  // because you marked them, and "Item 9412" is not a list entry anyone can read.
  const unnamed = out.filter((r) => r.name.startsWith("Item ")).map((r) => r.itemId);
  if (unnamed.length > 0) {
    const meta = await fetchItems(unnamed);
    for (const row of out) {
      const m = meta.get(row.itemId);
      if (!m) continue;
      row.name = m.name ?? row.name;
      row.level = row.level ?? m.level;
      row.type = row.type ?? m.type;
    }
  }

  out.sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
  return { rows: out };
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
  const missing = itemIds.filter((id) => !byItem.has(id));
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
