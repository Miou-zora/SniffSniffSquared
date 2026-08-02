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
  /** Units already in the bags, off the wire. */
  have: number;
  /** What is still missing — 0 once the bags cover the recipe. */
  short: number;
  /**
   * The buy plan for what is missing, not for the whole line. Null when nothing
   * in `prices` quotes this resource; absent once you own enough.
   */
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
  /** Resources the bags already cover in full. */
  covered: number;
  /** True when every resource is covered — nothing left to buy. */
  ready: boolean;
}

/**
 * How many units of each item are in the bags.
 *
 * Summed by item id: two stacks of the same resource are two rows on the wire
 * and two rows here, but one number at the counter.
 */
export async function held(itemIds: number[]): Promise<Map<number, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = await query<{ item_id: string; units: string }>(
    `SELECT item_id, sum(quantity) AS units
       FROM inventory
      WHERE item_id = ANY($1::bigint[])
      GROUP BY item_id`,
    [[...new Set(itemIds)]],
  );
  return new Map(rows.map((r) => [Number(r.item_id), Number(r.units)]));
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

/** A craft job, for the "everything this job makes between two levels" add. */
export interface JobOption {
  id: number;
  name: string;
}

/**
 * The game's jobs, from DofusDB. Cached for a week — the list changes with game
 * releases, not with play. An outage returns nothing, which hides the bulk add
 * rather than breaking the page.
 */
export async function craftJobs(): Promise<JobOption[]> {
  try {
    const res = await fetch("https://api.dofusdb.fr/jobs?$limit=50", {
      next: { revalidate: 604_800 },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    const out: JobOption[] = [];
    for (const raw of data) {
      const job = raw as { id?: unknown; name?: { fr?: unknown } };
      const id = Number(job.id);
      const name = job.name?.fr;
      if (!Number.isFinite(id) || typeof name !== "string") continue;
      out.push({ id, name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  } catch {
    return [];
  }
}

/** One craftable a job makes, with the recipe that came back alongside it. */
interface JobRecipe {
  itemId: number;
  level: number;
  ingredients: { itemId: number; quantity: number }[];
}

/** DofusDB serves 50 rows a request whatever `$limit` says. */
const PAGE = 50;
/** 20 pages of results is already an unreadable basket; past that it is a typo. */
const MAX_PAGES = 20;

/**
 * Everything `jobId` can make between two levels, recipe included.
 *
 * The recipe travels with the query, which is the point: adding 60 items would
 * otherwise be 60 more requests when the basket comes to price them.
 */
async function jobRecipes(
  jobId: number,
  minLevel: number,
  maxLevel: number,
): Promise<JobRecipe[]> {
  const out: JobRecipe[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let data: unknown;
    try {
      const url =
        `https://api.dofusdb.fr/recipes?jobId=${jobId}` +
        `&resultLevel[$gte]=${minLevel}&resultLevel[$lte]=${maxLevel}` +
        `&$limit=${PAGE}&$skip=${page * PAGE}` +
        `&$select[]=resultId&$select[]=resultLevel` +
        `&$select[]=ingredientIds&$select[]=quantities`;
      const res = await fetch(url, {
        next: { revalidate: 604_800 },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) break;
      const body: unknown = await res.json();
      data = (body as { data?: unknown }).data;
    } catch {
      // Whatever came back before the failure is still a usable basket.
      break;
    }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const raw of data) {
      const r = raw as {
        resultId?: unknown;
        resultLevel?: unknown;
        ingredientIds?: unknown;
        quantities?: unknown;
      };
      const itemId = Number(r.resultId);
      if (!Number.isFinite(itemId)) continue;
      const ids = r.ingredientIds;
      const quantities = r.quantities;
      // A mismatched pair is a recipe we cannot read rather than a partial one,
      // and half a recipe would price the item too cheaply.
      if (!Array.isArray(ids) || !Array.isArray(quantities)) continue;
      if (ids.length === 0 || ids.length !== quantities.length) continue;
      out.push({
        itemId,
        level: Number(r.resultLevel) || 0,
        ingredients: ids.map((id, i) => ({
          itemId: Number(id),
          quantity: Number(quantities[i]),
        })),
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Keep the recipes that came back with the job query.
 *
 * Same table and same shape as tools/import_items.py writes, and replaced
 * wholesale for the same reason: an ingredient dropped between game versions
 * has to lose its row rather than linger next to the new one.
 */
async function rememberRecipes(recipes: JobRecipe[]): Promise<void> {
  const withLines = recipes.filter((r) => r.ingredients.length > 0);
  if (withLines.length === 0) return;
  await query(`DELETE FROM recipes WHERE item_id = ANY($1::bigint[])`, [
    withLines.map((r) => r.itemId),
  ]);
  const tuples: string[] = [];
  const values: unknown[] = [];
  for (const recipe of withLines) {
    recipe.ingredients.forEach((ing, position) => {
      const i = values.length;
      tuples.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4})`);
      values.push(recipe.itemId, position, ing.itemId, ing.quantity);
    });
  }
  await query(
    `INSERT INTO recipes (item_id, position, ingredient_id, quantity)
     VALUES ${tuples.join(",")}
     ON CONFLICT (item_id, position) DO UPDATE SET
       ingredient_id = EXCLUDED.ingredient_id, quantity = EXCLUDED.quantity`,
    values,
  );
}

/**
 * Add everything a job makes in a level band, one copy each.
 *
 * Items already in the basket keep the quantity you set — a bulk add is "make
 * sure these are all in here", not "reset what I was doing".
 */
export async function addJobRange(
  jobId: number,
  minLevel: number,
  maxLevel: number,
): Promise<{ found: number; added: number; levels: [number, number] | null }> {
  const recipes = await jobRecipes(jobId, minLevel, maxLevel);
  if (recipes.length === 0) return { found: 0, added: 0, levels: null };

  await rememberRecipes(recipes);

  const inserted = await query<{ item_id: string }>(
    `INSERT INTO craft_basket (item_id, quantity)
     SELECT unnest($1::bigint[]), 1
     ON CONFLICT (item_id) DO NOTHING
     RETURNING item_id`,
    [recipes.map((r) => r.itemId)],
  );

  // Named now rather than on the next page load: 60 fresh ids is 60 rows
  // reading "Item 10181" until something asks DofusDB who they are, and the
  // answer is cached into `items` for every other page too.
  await fetchItems(recipes.map((r) => r.itemId));

  // The levels actually found, which is not always the band asked for: both
  // ends are inclusive, but a band can simply have nothing at its top. Saying
  // which levels came back is the only way to tell those two apart from the
  // outside, and "did it include 45?" is otherwise unanswerable.
  const levels = recipes.map((r) => r.level).filter((l) => l > 0);
  return {
    found: recipes.length,
    added: inserted.length,
    levels: levels.length > 0 ? [Math.min(...levels), Math.max(...levels)] : null,
  };
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
      covered: 0,
      ready: false,
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
        have: 0,
        short: 0,
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

  // What is already in the bags comes off the top: the trip is for what is
  // missing, and a line you can already cover costs nothing and needs no plan.
  const owned = await held([...totals.keys()]);
  let pooled = 0;
  for (const row of totals.values()) {
    row.have = owned.get(row.itemId) ?? 0;
    row.short = Math.max(0, row.quantity - row.have);
    const ladder = ladders.get(row.itemId);
    row.plan = row.short > 0 && ladder ? planBuy(row.short, ladder) : null;
    row.cost = row.short === 0 ? 0 : (row.plan?.cost ?? null);
    row.overbuy = row.plan ? row.plan.units - row.short : 0;
    // The batching comparison is about the whole recipe, stock aside — see the
    // note on `separate` below.
    pooled += (ladder ? planBuy(row.quantity, ladder)?.cost : null) ?? 0;
  }

  // Sorted by how much you have to buy, not by what it costs: the list is read
  // at the counter, where the number of units is the thing being matched
  // against what is in front of you. Ties by name, so the order is stable.
  const pile = [...totals.values()].sort(
    (a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "fr"),
  );

  // A line you already own does not need a price to be settled, so it is not
  // counted as missing one.
  const unpriced = pile.filter((r) => r.short > 0 && r.cost === null).length;
  const cost = unpriced > 0 ? null : pile.reduce((sum, r) => sum + (r.cost ?? 0), 0);

  // What one entry costs on its own, and what the same shopping costs bought
  // per craft. Both sides skip the resources with no price rather than giving
  // up: an unpriced ingredient makes the *total* unknowable, but it says
  // nothing about whether pooling the rest was worth doing, and that comparison
  // is the reason this page exists.
  //
  // Both also ignore what is already in the bags. They answer a question about
  // batching -- one trip or several -- and subtracting stock from one side only
  // would turn that into a different, meaningless number.
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
    pooled,
    separate,
    uncraftable: entries.filter((e) => e.ingredients === null).length,
    covered: pile.filter((r) => r.short === 0).length,
    ready: pile.length > 0 && pile.every((r) => r.short === 0),
  };
}
