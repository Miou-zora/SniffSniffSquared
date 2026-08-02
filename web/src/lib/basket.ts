/**
 * The craft basket: several things you mean to make, and the one pile of
 * resources that buys them all.
 *
 * The point is the pooling. Two crafts that each want 2 Ébonite are one line of
 * 4 at the counter, and the batch ladder prices 4 differently from 2 twice over
 * — a x10 can beat four x1. Planning each craft on its own gets the shopping
 * list right and the price wrong, so quantities are summed across the whole
 * basket first and `planBuy` runs once per ingredient.
 *
 * Ingredients are taken one level deep. An ingredient that is itself craftable
 * is priced as a purchase, because that is what the trip to the HDV is: the
 * question here is what to buy, not what to make on the way.
 */
import { fetchItems, fetchRecipe, latestLadders } from "@/lib/breaker";
import { planBuy, type BuyPlan } from "@/lib/craft";
import { query } from "@/lib/db";

/** One thing you mean to craft, and how many copies. */
export interface BasketEntry {
  itemId: number;
  name: string;
  level: number | null;
  type: string | null;
  /** DofusDB icon id, null when it has none — pass through `iconUrl`. */
  iconId: number | null;
  quantity: number;
  /** Null when the item has no recipe — nothing to buy, and nothing to pool. */
  ingredients: { itemId: number; quantity: number }[] | null;
  /** What this entry alone costs in ingredients, null when one has no price. */
  cost: number | null;
}

/** Which craft wants how much of an ingredient, so a big line explains itself. */
export interface PileNeed {
  itemId: number;
  name: string;
  quantity: number;
}

/** One resource to buy, summed over every craft in the basket. */
export interface PileRow {
  itemId: number;
  name: string;
  /**
   * DofusDB icon id. A list of resource names is hard to match against what is
   * on the screen in front of you; the icon is what the HDV actually shows.
   */
  iconId: number | null;
  /** Units the recipes ask for. */
  quantity: number;
  /** Null when nothing in `prices` quotes this resource. */
  plan: BuyPlan | null;
  cost: number | null;
  /** Units the plan buys beyond what is needed, because a batch overshot. */
  overbuy: number;
  needBy: PileNeed[];
}

export interface BasketView {
  entries: BasketEntry[];
  pile: PileRow[];
  /** Total for the pooled trip. Null while any ingredient has no price. */
  cost: number | null;
  /** Ingredients with no captured price — the reason `cost` may be null. */
  unpriced: number;
  /**
   * `pooled` and `separate` price the same shopping two ways — one trip for the
   * basket, versus a trip per craft — over the resources that have a price.
   * They exclude the unpriced ones on both sides, so the difference between
   * them is meaningful even when the total is not yet known.
   */
  pooled: number;
  separate: number;
  /** Basket items with no recipe at all. */
  uncraftable: number;
}

export async function basketQuantities(): Promise<Map<number, number>> {
  const rows = await query<{ item_id: string; quantity: number }>(
    `SELECT item_id, quantity FROM craft_basket ORDER BY added_at`,
  );
  return new Map(rows.map((r) => [Number(r.item_id), r.quantity]));
}

/** Set how many copies to craft. A quantity of 0 or less takes it out. */
export async function setBasket(itemId: number, quantity: number): Promise<void> {
  if (quantity <= 0) {
    await query(`DELETE FROM craft_basket WHERE item_id = $1`, [itemId]);
    return;
  }
  await query(
    `INSERT INTO craft_basket (item_id, quantity) VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [itemId, quantity],
  );
}

export async function clearBasket(): Promise<void> {
  await query(`DELETE FROM craft_basket`);
}

/**
 * Recipes for many items at once.
 *
 * `recipes` first, DofusDB for what the importer has not reached — the same two
 * sources, in the same order, as the breaker's craft estimate. An item with no
 * recipe maps to null rather than an empty list, because "cannot be crafted" and
 * "recipe not loaded" would otherwise read alike.
 */
async function recipesFor(
  itemIds: number[],
): Promise<Map<number, { itemId: number; quantity: number }[] | null>> {
  const out = new Map<number, { itemId: number; quantity: number }[] | null>();
  if (itemIds.length === 0) return out;

  const rows = await query<{ item_id: string; ingredient_id: string; quantity: number }>(
    `SELECT item_id, ingredient_id, quantity
       FROM recipes
      WHERE item_id = ANY($1::bigint[])
      ORDER BY item_id, position`,
    [itemIds],
  );
  for (const r of rows) {
    const id = Number(r.item_id);
    const lines = out.get(id) ?? [];
    lines.push({ itemId: Number(r.ingredient_id), quantity: r.quantity });
    out.set(id, lines);
  }

  const missing = itemIds.filter((id) => !out.has(id));
  const live = await Promise.all(missing.map((id) => fetchRecipe(id)));
  missing.forEach((id, i) => {
    const recipe = live[i];
    out.set(
      id,
      recipe === null || recipe === undefined
        ? null
        : recipe.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
    );
  });
  return out;
}

interface Named {
  name: string | null;
  level: number | null;
  type: string | null;
  iconId: number | null;
}

/** Names, levels, types and icons for a set of ids, `items` first then DofusDB. */
async function namesFor(itemIds: number[]): Promise<Map<number, Named>> {
  const out = new Map<number, Named>();
  if (itemIds.length === 0) return out;
  const rows = await query<{
    item_id: string;
    name_fr: string | null;
    level: number | null;
    type_fr: string | null;
    icon_id: string | null;
  }>(
    `SELECT item_id, name_fr, level, type_fr, icon_id
       FROM items WHERE item_id = ANY($1::bigint[])`,
    [itemIds],
  );
  for (const r of rows) {
    out.set(Number(r.item_id), {
      name: r.name_fr,
      level: r.level,
      type: r.type_fr,
      iconId: r.icon_id === null ? null : Number(r.icon_id),
    });
  }
  // Ingredients are usually ids the wire has never seen, so most of a fresh
  // basket resolves here rather than from the database. A row named before
  // `icon_id` existed is asked for again for the same reason: the answer is
  // cached back into `items`, so it is one round trip per item ever.
  const incomplete = itemIds.filter((id) => {
    const known = out.get(id);
    return !known?.name || known.iconId === null;
  });
  if (incomplete.length > 0) {
    for (const [id, meta] of await fetchItems(incomplete)) {
      out.set(id, {
        name: meta.name,
        level: meta.level,
        type: meta.type,
        iconId: meta.iconId,
      });
    }
  }
  return out;
}

export async function loadBasket(): Promise<BasketView> {
  const quantities = await basketQuantities();
  const itemIds = [...quantities.keys()];
  if (itemIds.length === 0) {
    return {
      entries: [],
      pile: [],
      cost: 0,
      unpriced: 0,
      pooled: 0,
      separate: 0,
      uncraftable: 0,
    };
  }

  const recipes = await recipesFor(itemIds);

  // Every id on the page in one naming pass, and one ladder query for the lot.
  const ingredientIds = new Set<number>();
  for (const lines of recipes.values()) {
    for (const line of lines ?? []) ingredientIds.add(line.itemId);
  }
  const [names, ladders] = await Promise.all([
    namesFor([...new Set([...itemIds, ...ingredientIds])]),
    latestLadders([...ingredientIds]),
  ]);

  const named = (id: number) => names.get(id)?.name ?? `Item ${id}`;

  const entries: BasketEntry[] = itemIds.map((id) => {
    const meta = names.get(id);
    const lines = recipes.get(id) ?? null;
    return {
      itemId: id,
      name: named(id),
      level: meta?.level ?? null,
      type: meta?.type ?? null,
      iconId: meta?.iconId ?? null,
      quantity: quantities.get(id) ?? 1,
      ingredients: lines,
      cost: null,
    };
  });

  // Pool first, price second: the whole trip's quantity is what the ladder is
  // asked about.
  const totals = new Map<number, PileRow>();
  for (const entry of entries) {
    for (const line of entry.ingredients ?? []) {
      const need = line.quantity * entry.quantity;
      const row = totals.get(line.itemId) ?? {
        itemId: line.itemId,
        name: named(line.itemId),
        iconId: names.get(line.itemId)?.iconId ?? null,
        quantity: 0,
        plan: null,
        cost: null,
        overbuy: 0,
        needBy: [],
      };
      row.quantity += need;
      row.needBy.push({ itemId: entry.itemId, name: entry.name, quantity: need });
      totals.set(line.itemId, row);
    }
  }

  for (const row of totals.values()) {
    const ladder = ladders.get(row.itemId);
    row.plan = ladder ? planBuy(row.quantity, ladder) : null;
    row.cost = row.plan?.cost ?? null;
    row.overbuy = row.plan ? row.plan.units - row.quantity : 0;
  }

  // Sorted by how much you have to buy, not by what it costs: the list is read
  // at the counter, where the number of units is the thing being matched
  // against what is in front of you. Ties by name, so the order is stable.
  const pile = [...totals.values()].sort(
    (a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "fr"),
  );

  const unpriced = pile.filter((r) => r.cost === null).length;
  const cost = unpriced > 0 ? null : pile.reduce((sum, r) => sum + (r.cost ?? 0), 0);

  // What one entry costs on its own, and what the same shopping costs bought
  // per craft. Both sides skip the resources with no price rather than giving
  // up: an unpriced ingredient makes the *total* unknowable, but it says
  // nothing about whether pooling the rest was worth doing, and that comparison
  // is the reason this page exists.
  let separate = 0;
  for (const entry of entries) {
    if (entry.ingredients === null) continue;
    let own: number | null = 0;
    for (const line of entry.ingredients) {
      const ladder = ladders.get(line.itemId);
      const plan = ladder ? planBuy(line.quantity * entry.quantity, ladder) : null;
      if (plan === null) {
        own = null;
        continue;
      }
      separate += plan.cost;
      if (own !== null) own += plan.cost;
    }
    entry.cost = own;
  }

  return {
    entries,
    pile,
    cost,
    unpriced,
    pooled: pile.reduce((sum, r) => sum + (r.cost ?? 0), 0),
    separate,
    uncraftable: entries.filter((e) => e.ingredients === null).length,
  };
}
