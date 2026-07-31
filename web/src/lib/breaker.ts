import { query } from "@/lib/db";
import { planBuy, type BuyPlan, type Ladder } from "@/lib/craft";
import {
  coefficientColumns,
  focusOutcomes,
  noFocusOutcome,
  lineWeight,
  weighLines,
  type CoefficientColumn,
  type FocusOutcome,
  type StatLine,
  type WeightedLine,
} from "@/lib/brisage";

/** What a template says a line rolls between, and the middle of that range. */
export interface AverageStat {
  min: number;
  max: number;
  avg: number;
  /** `line_weight` if the line rolled the average instead of what it did. */
  avgWeight: number;
}

/** One set of weights — either what this copy rolled or what the type averages. */
export interface ProjectionBasis {
  focuses: {
    rune: string;
    effectId: number;
    runeWeight: number;
    focusWeight: number;
    unitPrice: number | null;
  }[];
  /** No-focus crushing: each line yields its own rune independently. */
  noFocusLines: { weight: number; runeWeight: number; unitPrice: number | null }[];
}

/** One line of a recipe, with what buying that many actually costs. */
export interface CraftIngredient {
  itemId: number;
  name: string;
  quantity: number;
  /** Null when nothing has been captured for this ingredient. */
  plan: BuyPlan | null;
}

/**
 * What the item costs to make rather than to buy.
 *
 * `cost` is null whenever a single ingredient is unpriced: a sum over the ones
 * that happen to be on the market is not a cheaper craft, it is a wrong one,
 * and it would read as the best number on the page.
 */
export interface CraftEstimate {
  cost: number | null;
  ingredients: CraftIngredient[];
  /**
   * `db` came from the `recipes` table, `dofusdb` was fetched live because the
   * table had no row. Worth showing: the second means the importer has not seen
   * this item, so a DofusDB outage would make the estimate disappear.
   */
  source: "db" | "dofusdb";
}

/**
 * Everything the projection table needs, flat enough to hand to a Client
 * Component. The client recomputes at arbitrary coefficients for the custom
 * column, so it gets weights and prices rather than precomputed rows.
 *
 * Both bases are computed here rather than on demand: they differ only in the
 * weight per line, the prices and columns are shared, and sending both means
 * the switch is instant and needs no round trip.
 */
export interface ProjectionModel {
  coefficient: number;
  /** True when no crush of THIS item has been seen, so 100% is a placeholder. */
  coefficientAssumed: boolean;
  /** When the crush it came from was observed. */
  coefficientSeenAt: string | null;
  /** The item's market price: cheapest current listing, or the last ladder. */
  itemCost: number | null;
  /** How many listings that price was the cheapest of. 0 when it came from a ladder. */
  offerCount: number;
  /** What its ingredients cost, or null when the item has no recipe at all. */
  craft: CraftEstimate | null;
  /** What this instance rolled, off the wire. */
  copy: ProjectionBasis;
  /**
   * The same item if every line rolled the middle of its template range. Null
   * when the template does not cover every line that yields a rune — a partial
   * average would read as a worse item rather than as missing data.
   */
  average: ProjectionBasis | null;
}

export interface BreakerView {
  item: { itemId: number; name: string; level: number; type: string | null };
  uid: number | null;
  /** When it was put into the breaker. Null when browsing an item you do not hold. */
  placedAt: Date | null;
  /** Every line the wire reported, rune-mapped or not. */
  lines: StatLine[];
  /** Only the lines that yield a rune, with weights. */
  weighted: WeightedLine[];
  totalWeight: number;
  /** Template ranges by effect id. Empty when the item has never been enriched. */
  averages: Map<number, AverageStat>;
  /** Total weight if every line rolled the middle of its range. */
  averageTotalWeight: number | null;
  projection: ProjectionModel;
  /** Lines that map to no rune — weapon damage, maluses. Shown, not summed. */
  unmapped: StatLine[];
  coefficient: number;
  /** True when no crush has been seen and the coefficient is a placeholder. */
  coefficientIsAssumed: boolean;
  columns: CoefficientColumn[];
  outcomes: FocusOutcome[];
  noFocus: ReturnType<typeof noFocusOutcome>;
  itemCost: number | null;
  /** Runes among `outcomes` with no captured market price. */
  unpricedRunes: string[];
}

interface PlacementRow extends Record<string, unknown> {
  item_id: string;
  uid: string | null;
  placed_at: Date;
}

interface StatRow extends Record<string, unknown> {
  effect_id: string;
  value: string;
  rune: string | null;
  rune_weight: number | null;
  stat_per_rune: number | null;
  rune_item_id: string | null;
}

interface ItemRow extends Record<string, unknown> {
  item_id: string;
  name_fr: string | null;
  level: number | null;
  type_fr: string | null;
}

/**
 * The item currently sitting in the breaker, with the whole model applied.
 *
 * "Currently" means the most recent placement. A placement is not a crush — an
 * item can sit in the slot indefinitely while a focus is chosen — which is
 * exactly the moment this page is meant to be useful.
 */
export async function loadBreaker(): Promise<BreakerView | null> {
  const [placement] = await query<PlacementRow>(
    `SELECT item_id, uid, placed_at
       FROM crush_placements
      ORDER BY placed_at DESC, id DESC
      LIMIT 1`,
  );
  if (!placement) return null;

  const itemId = Number(placement.item_id);

  // Placements recorded before the uid column existed carry only the type, so
  // fall back to the most recently described instance of that type.
  let uid = placement.uid === null ? null : Number(placement.uid);
  if (uid === null) uid = await lastKnownInstance(itemId);

  return buildView(itemId, uid, placement.placed_at);
}

/**
 * The same view for any item id, whether or not you hold one.
 *
 * The interesting case is an item you broke last week or have never owned: the
 * decision "is this worth buying to break" is made before it is in your hands,
 * and until now the page could only answer it for whatever sat in the breaker.
 *
 * It reuses the last instance of that type seen on the wire, if there is one,
 * so a copy you broke still shows what it rolled. With none, the Current item
 * basis is empty and the Average basis carries the page — which is the honest
 * shape of the question for an item you do not have.
 */
export async function loadItem(itemId: number): Promise<BreakerView | null> {
  if (!Number.isInteger(itemId) || itemId <= 0) return null;

  // An id nobody has ever heard of gets a 404 rather than a page of empty
  // panels headed "Item 999999999", which reads like the data is missing rather
  // than like the item does not exist.
  const [known] = await query<{ item_id: string }>(
    `SELECT item_id FROM items WHERE item_id = $1`,
    [itemId],
  );
  if (!known && !(await fetchItems([itemId])).has(itemId)) return null;

  return buildView(itemId, await lastKnownInstance(itemId), null);
}

/** The most recently described instance of an item type, if the wire saw one. */
async function lastKnownInstance(itemId: number): Promise<number | null> {
  const [row] = await query<{ uid: string }>(
    `SELECT uid FROM item_stats WHERE item_id = $1 ORDER BY seen_at DESC LIMIT 1`,
    [itemId],
  );
  return row ? Number(row.uid) : null;
}

async function buildView(
  itemId: number,
  uid: number | null,
  placedAt: Date | null,
): Promise<BreakerView | null> {
  const [itemRow] = await query<ItemRow>(
    `SELECT item_id, name_fr, level, type_fr FROM items WHERE item_id = $1`,
    [itemId],
  );

  // Everything the `items` and `item_effects` tables would have held if the
  // importer had reached this id, fetched once and only when something is
  // actually missing. Memoised because two unrelated gaps — no level, no
  // template — must not cost two requests for the same item.
  let metaOnce: Promise<ItemMeta | null> | undefined;
  const meta = () =>
    (metaOnce ??= fetchItems([itemId]).then((m) => m.get(itemId) ?? null));

  // The level is not decoration: line_weight multiplies by level/200, so an
  // unimported item defaulting to level 1 does not read as "unknown", it reads
  // as a plausible and completely wrong projection.
  const named = itemRow?.level == null ? await meta() : null;

  const statRows = uid
    ? await query<StatRow>(
        `SELECT s.effect_id, s.value, r.rune, r.rune_weight, r.stat_per_rune,
                r.item_id AS rune_item_id
           FROM item_stats s
           LEFT JOIN runes r ON r.effect_id = s.effect_id
          WHERE s.uid = $1
          ORDER BY s.value DESC`,
        [uid],
      )
    : [];

  const lines: StatLine[] = statRows.map((r) => ({
    effectId: Number(r.effect_id),
    value: Number(r.value),
    rune: r.rune,
    runeWeight: r.rune_weight ?? 0,
    statPerRune: r.stat_per_rune ?? 1,
    runeItemId: r.rune_item_id === null ? null : Number(r.rune_item_id),
  }));

  const level = itemRow?.level ?? named?.level ?? 1;
  const weighted = weighLines(lines, level).sort((a, b) => b.weight - a.weight);
  const totalWeight = weighted.reduce((s, l) => s + l.weight, 0);
  const unmapped = lines.filter((l) => l.rune === null);

  // The coefficient belongs to the item type, not to the account. Two capes
  // crushed a minute apart came out at 88.06% and 87.60%, a hat two hours later
  // at 17.95%, and a bow at 32.19% — each item type carries its own rate, so
  // the only crush that says anything about this one is a crush of this one.
  //
  // This used to take the most recent crush of anything, which meant the page
  // confidently applied a hat's rate to a belt. An unrelated item's figure is
  // not a weaker estimate, it is a different number entirely; with none of this
  // item's own, the honest answer is that it is unknown.
  const [coeffRow] = await query<{ yield_percent: number; seen_at: Date }>(
    `SELECT yield_percent, seen_at FROM crushes
      WHERE item_id = $1
      ORDER BY seen_at DESC, id DESC LIMIT 1`,
    [itemId],
  );
  const coefficient = coeffRow?.yield_percent ?? 100;

  const runeIds = weighted
    .map((l) => l.runeItemId)
    .filter((id): id is number => id !== null);
  const priceByRuneItemId = await latestPrices([...new Set(runeIds)]);

  const columns = coefficientColumns(coefficient);
  const outcomes = focusOutcomes(weighted, columns, priceByRuneItemId).sort((a, b) => {
    const av = a.value[1] ?? -1;
    const bv = b.value[1] ?? -1;
    // No price is not "worth zero" — it sorts last, below anything priced.
    if (av !== bv) return bv - av;
    return b.runes[1] - a.runes[1];
  });

  const market = await marketPrice(itemId);
  const costRow = market.cost;

  // What the item type can roll, for comparison against what this copy did.
  // From item_effects when the importer has seen the id, and from DofusDB when
  // it has not — the Average basis is the whole answer to "is this item worth
  // buying to break", so waiting on an offline run to have it is the wrong
  // trade. Both carry the same numbers; only the latency differs.
  const rangeRows = await query<{
    effect_id: string;
    min_value: string;
    max_value: string;
  }>(
    `SELECT effect_id, min_value, max_value FROM item_effects
      WHERE item_id = $1 ORDER BY position`,
    [itemId],
  );
  const ranges =
    rangeRows.length > 0
      ? rangeRows.map((r) => ({
          effectId: Number(r.effect_id),
          min: Number(r.min_value),
          max: Number(r.max_value),
        }))
      : ((await meta())?.ranges ?? []);

  const byEffect = new Map(lines.map((l) => [l.effectId, l]));
  const averages = new Map<number, AverageStat>();
  for (const r of ranges) {
    const effectId = r.effectId;
    // A template can list an effect twice; the first is the one a stat line
    // would be compared against, so later duplicates are ignored.
    if (averages.has(effectId)) continue;
    const min = r.min;
    const max = r.max;
    const avg = (min + max) / 2;
    const line = byEffect.get(effectId);
    averages.set(effectId, {
      min,
      max,
      avg,
      avgWeight:
        line && line.rune !== null
          ? lineWeight(avg, line.runeWeight, line.statPerRune, level)
          : 0,
    });
  }
  // Only meaningful if the template covers every line that yields a rune —
  // a partial sum would read as a smaller item rather than as missing data.
  const averageTotalWeight = weighted.every((l) => averages.has(l.effectId))
    ? weighted.reduce((s, l) => s + (averages.get(l.effectId)?.avgWeight ?? 0), 0)
    : null;

  return {
    item: {
      itemId,
      name: itemRow?.name_fr ?? named?.name ?? `Item ${itemId}`,
      level,
      type: itemRow?.type_fr ?? named?.type ?? null,
    },
    uid,
    placedAt,
    lines,
    weighted,
    totalWeight,
    unmapped,
    coefficient,
    coefficientIsAssumed: !coeffRow,
    columns,
    outcomes,
    noFocus: noFocusOutcome(weighted, columns, priceByRuneItemId),
    itemCost: costRow,
    unpricedRunes: outcomes.filter((o) => o.unitPrice === null).map((o) => o.rune),
    averages,
    averageTotalWeight,
    projection: {
      coefficient,
      coefficientAssumed: !coeffRow,
      coefficientSeenAt: coeffRow ? coeffRow.seen_at.toISOString() : null,
      itemCost: costRow,
      offerCount: market.offers,
      craft: await craftEstimate(itemId),
      copy: basisOf(weighted, outcomes, priceByRuneItemId),
      average: averageBasis(weighted, outcomes, columns, priceByRuneItemId, averages),
    },
  };
}

/** A basis in the shape the client wants, ordered to match `outcomes`. */
function basisOf(
  lines: WeightedLine[],
  outcomes: FocusOutcome[],
  priceByRuneItemId: Map<number, number>,
): ProjectionBasis {
  return {
    focuses: outcomes.map((o) => ({
      rune: o.rune,
      effectId: o.effectId,
      runeWeight: o.runeWeight,
      focusWeight: o.focusWeight,
      unitPrice: o.unitPrice,
    })),
    noFocusLines: lines.map((l) => ({
      weight: l.weight,
      runeWeight: l.runeWeight,
      unitPrice:
        l.runeItemId === null ? null : (priceByRuneItemId.get(l.runeItemId) ?? null),
    })),
  };
}

/**
 * The projection for an average copy of this item type.
 *
 * Rows keep the order the copy's outcomes were sorted into, so switching basis
 * changes the figures and never reshuffles the table under the cursor. The best
 * focus can differ between the two, which is a thing to read rather than a thing
 * to animate.
 */
function averageBasis(
  weighted: WeightedLine[],
  outcomes: FocusOutcome[],
  columns: CoefficientColumn[],
  priceByRuneItemId: Map<number, number>,
  averages: Map<number, AverageStat>,
): ProjectionBasis | null {
  if (weighted.length === 0) return null;
  if (!weighted.every((l) => averages.has(l.effectId))) return null;

  const avgLines = weighted.map((l) => ({
    ...l,
    weight: averages.get(l.effectId)?.avgWeight ?? l.weight,
  }));
  const avgOutcomes = focusOutcomes(avgLines, columns, priceByRuneItemId);
  const byEffectId = new Map(avgOutcomes.map((o) => [o.effectId, o]));
  // Ordered by the copy's ranking, dropping nothing: every line that has an
  // outcome under one basis has one under the other.
  const ordered = outcomes
    .map((o) => byEffectId.get(o.effectId))
    .filter((o): o is FocusOutcome => o !== undefined);
  if (ordered.length !== outcomes.length) return null;

  return basisOf(avgLines, ordered, priceByRuneItemId);
}

/**
 * What the item costs to craft, ingredient by ingredient.
 *
 * Null when the item has no recipe — most resources do not, and that is not a
 * failure. Recipes come from `recipes`, filled offline by tools/import_items.py,
 * so an item whose recipe has never been imported reads the same as one that
 * has none. Both are answered by running the importer.
 */
async function craftEstimate(itemId: number): Promise<CraftEstimate | null> {
  const stored = await query<{
    ingredient_id: string;
    quantity: number;
    name_fr: string | null;
  }>(
    `SELECT r.ingredient_id, r.quantity, i.name_fr
       FROM recipes r
       LEFT JOIN items i ON i.item_id = r.ingredient_id
      WHERE r.item_id = $1
      ORDER BY r.position`,
    [itemId],
  );

  let source: CraftEstimate["source"] = "db";
  let lines = stored.map((r) => ({
    itemId: Number(r.ingredient_id),
    quantity: r.quantity,
    name: r.name_fr,
  }));

  // An item the importer has not seen yet is the common case while playing —
  // you put something in the breaker minutes after first meeting it. Falling
  // back to DofusDB means the page answers now instead of after a manual run.
  if (lines.length === 0) {
    const live = await fetchRecipe(itemId);
    if (live === null) return null;
    source = "dofusdb";
    lines = live;
    const names = await query<{ item_id: string; name_fr: string | null }>(
      `SELECT item_id, name_fr FROM items WHERE item_id = ANY($1::bigint[])`,
      [lines.map((l) => l.itemId)],
    );
    const byId = new Map(names.map((n) => [Number(n.item_id), n.name_fr]));
    // A recipe the importer has never seen has ingredients it has never named
    // either, and "Item 6841" is unreadable in the one message that matters —
    // the list of what still needs a price.
    const unnamed = lines.filter((l) => !byId.get(l.itemId)).map((l) => l.itemId);
    if (unnamed.length > 0) {
      for (const [id, name] of await fetchItemNames(unnamed)) byId.set(id, name);
    }
    lines = lines.map((l) => ({ ...l, name: byId.get(l.itemId) ?? null }));
  }

  const ladders = await latestLadders(lines.map((l) => l.itemId));
  const ingredients: CraftIngredient[] = lines.map((l) => {
    const ladder = ladders.get(l.itemId);
    return {
      itemId: l.itemId,
      name: l.name ?? `Item ${l.itemId}`,
      quantity: l.quantity,
      plan: ladder ? planBuy(l.quantity, ladder) : null,
    };
  });

  const priced = ingredients.every((i) => i.plan !== null);
  return {
    cost: priced ? ingredients.reduce((sum, i) => sum + (i.plan?.cost ?? 0), 0) : null,
    ingredients,
    source,
  };
}

/** Name, level and type for ids the `items` table has never been told about. */
interface ItemMeta {
  name: string | null;
  level: number | null;
  type: string | null;
  /** The template: what each line on this item type can roll between. */
  ranges: { effectId: number; min: number; max: number }[];
}

/**
 * `[(effectId, min, max)]` from a DofusDB item's template.
 *
 * DofusDB reports a fixed-value line as `from = N, to = 0`, so a `to` below
 * `from` means "always N" rather than an inverted range. Reading it the other
 * way silently halves those lines. Mirrors `effect_ranges` in
 * tools/import_items.py — the same rule, applied at read time.
 */
function effectRanges(raw: unknown): ItemMeta["ranges"] {
  const effects = (raw as { effects?: unknown }).effects;
  if (!Array.isArray(effects)) return [];
  const out: ItemMeta["ranges"] = [];
  for (const e of effects) {
    const eff = e as { effectId?: unknown; from?: unknown; to?: unknown };
    const effectId = Number(eff.effectId);
    const min = Number(eff.from);
    if (!Number.isFinite(effectId) || !Number.isFinite(min)) continue;
    const to = Number(eff.to);
    out.push({ effectId, min, max: Number.isFinite(to) && to >= min ? to : min });
  }
  return out;
}

async function fetchItems(itemIds: number[]): Promise<Map<number, ItemMeta>> {
  const out = new Map<number, ItemMeta>();
  if (itemIds.length === 0) return out;
  try {
    const params = itemIds.map((id) => `id[$in][]=${id}`).join("&");
    const res = await fetch(
      `https://api.dofusdb.fr/items?$limit=${itemIds.length}&${params}`,
      { next: { revalidate: 604_800 }, signal: AbortSignal.timeout(4_000) },
    );
    if (!res.ok) return out;
    const body: unknown = await res.json();
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return out;
    for (const raw of data) {
      const it = raw as {
        id?: unknown;
        level?: unknown;
        name?: { fr?: unknown };
        type?: { name?: { fr?: unknown } };
      };
      const id = Number(it.id);
      if (!Number.isFinite(id)) continue;
      out.set(id, {
        name: typeof it.name?.fr === "string" ? it.name.fr : null,
        level: Number.isFinite(Number(it.level)) ? Number(it.level) : null,
        type: typeof it.type?.name?.fr === "string" ? it.type.name.fr : null,
        ranges: effectRanges(raw),
      });
    }
  } catch {
    // Enrichment is a nicety; every caller has a fallback.
  }
  return out;
}

async function fetchItemNames(itemIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const [id, meta] of await fetchItems(itemIds)) {
    if (meta.name !== null) out.set(id, meta.name);
  }
  return out;
}

/**
 * One item's recipe from DofusDB, or null when it has none — most items do not,
 * and that is not a failure.
 *
 * Cached for a week: recipes are static between game patches, so this is one
 * request per item per week rather than one per page view. Every failure path
 * returns null, because a craft estimate is worth less than the page: an
 * outage, a timeout or a shape we cannot read must all degrade to "no recipe"
 * rather than take the breaker view down with them.
 */
async function fetchRecipe(
  itemId: number,
): Promise<{ itemId: number; quantity: number; name: string | null }[] | null> {
  try {
    const res = await fetch(
      `https://api.dofusdb.fr/recipes?resultId=${itemId}&$limit=1`,
      { next: { revalidate: 604_800 }, signal: AbortSignal.timeout(4_000) },
    );
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0] as { ingredientIds?: unknown; quantities?: unknown };
    const ids = first.ingredientIds;
    const quantities = first.quantities;
    if (!Array.isArray(ids) || !Array.isArray(quantities)) return null;
    // A mismatched pair is a recipe we cannot read rather than a partial one,
    // and half a recipe would price the item too cheaply.
    if (ids.length === 0 || ids.length !== quantities.length) return null;
    return ids.map((id, i) => ({
      itemId: Number(id),
      quantity: Number(quantities[i]),
      name: null,
    }));
  } catch {
    return null;
  }
}

/**
 * What one copy of this item costs on the market right now.
 *
 * Gear is sold as individual listings, so "the price" is the cheapest one
 * currently on offer, not an arbitrary seller's asking price — the spread is
 * routinely two orders of magnitude, and picking wrong makes every profit
 * figure on the page wrong with it.
 *
 * Only the most recent snapshot counts. Every listing in a panel arrives in one
 * message and lands within the same instant, so a short window around the
 * newest row is exactly that panel; older rows are listings that may well be
 * sold by now.
 *
 * Resources have no listings, only a stack quote, and fall back to `prices`.
 */
async function marketPrice(
  itemId: number,
): Promise<{ cost: number | null; offers: number }> {
  const [row] = await query<{ cheapest: string | null; offers: string }>(
    `SELECT min(price) AS cheapest, count(*) AS offers
       FROM offers
      WHERE item_id = $1
        AND seen_at >= (SELECT max(seen_at) - interval '10 seconds'
                          FROM offers WHERE item_id = $1)`,
    [itemId],
  );
  if (row?.cheapest != null) {
    return { cost: Number(row.cheapest), offers: Number(row.offers) };
  }
  const ladder = await latestPrices([itemId]);
  return { cost: ladder.get(itemId) ?? null, offers: 0 };
}

/**
 * Latest full ladder per item id.
 *
 * Rows where every batch size reads 0 are skipped rather than taken as the
 * latest word: that is a capture in which nothing was on sale, and letting it
 * mask an earlier real ladder would turn a priced ingredient into an unpriced
 * one for no reason.
 */
async function latestLadders(itemIds: number[]): Promise<Map<number, Ladder>> {
  if (itemIds.length === 0) return new Map();
  const rows = await query<{
    item_id: string;
    b1: string;
    b10: string;
    b100: string;
    b1000: string;
  }>(
    `SELECT DISTINCT ON (item_id) item_id, b1, b10, b100, b1000
       FROM prices
      WHERE item_id = ANY($1::bigint[])
        AND (b1 > 0 OR b10 > 0 OR b100 > 0 OR b1000 > 0)
      ORDER BY item_id, seen_at DESC`,
    [[...new Set(itemIds)]],
  );
  return new Map(
    rows.map((r) => [
      Number(r.item_id),
      {
        b1: Number(r.b1),
        b10: Number(r.b10),
        b100: Number(r.b100),
        b1000: Number(r.b1000),
      },
    ]),
  );
}

/**
 * Latest single-unit price per item id. A `b1` of 0 means that batch size was
 * not on sale, which is absence of a price rather than a price of nothing.
 */
async function latestPrices(itemIds: number[]): Promise<Map<number, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = await query<{ item_id: string; b1: string }>(
    `SELECT DISTINCT ON (item_id) item_id, b1
       FROM prices
      WHERE item_id = ANY($1::bigint[]) AND b1 > 0
      ORDER BY item_id, seen_at DESC`,
    [itemIds],
  );
  return new Map(rows.map((r) => [Number(r.item_id), Number(r.b1)]));
}
