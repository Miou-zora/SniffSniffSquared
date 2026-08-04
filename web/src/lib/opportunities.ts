/**
 * Which consumable/resource recipes are worth crafting and selling on the
 * HDV, per job (métier).
 *
 * Deliberately excludes equipment: the breaker/worth pages already answer "is
 * this worth crafting to wear or to break," and gear's real price comes from
 * individual listings (`offers`), not the batch ladder this feature reads.
 * Scope and the whitelist below are the approved design at
 * docs/superpowers/specs/2026-08-03-craft-opportunities-dashboard-design.md.
 */
import { craftJobs, jobRecipes, rememberRecipes, type JobOption } from "@/lib/basket";
import { fetchItems, latestLadders } from "@/lib/breaker";
import { margin, unitPrice } from "@/lib/craft";
import { query } from "@/lib/db";
import { NOT_STUFF_SUPER_TYPES } from "@/lib/kind";
import { CHARACTER_SHARE, RECYCLE_BONUSES } from "@/lib/recycle";

/**
 * "Pépite" — the nugget as a tradeable item, so recycling has a kamas value.
 *
 * Verified: DofusDB 14635, `Pierre précieuse`, and the only item of that name
 * with a captured ladder. The other four "pépite" items are a Sakaï fragment
 * and three Dimensions Divines trinkets, none of which the recycler pays in.
 */
const NUGGET_ITEM_ID = 14635;

/**
 * Runes have no super-type of their own — they fall under Ressource (9) — so
 * they are excluded by name prefix on top of the whitelist above. Same rule as
 * `isBreakableKind` (lib/kind.ts) and `IS_EQUIPMENT` (lib/broken.ts); change
 * all three together if it ever stops being name-based.
 */
const NOT_RUNE_SQL = `NOT COALESCE(i.type_fr LIKE 'Rune%', false)`;

export interface OpportunityRow {
  itemId: number;
  name: string;
  level: number | null;
  iconId: number | null;
  /**
   * False for a row that only exists because it is worth recycling — a dropped
   * resource or a rune. Those carry no job, no cost and no margin, and the
   * craft bonus does not apply to their yield.
   */
  craftable: boolean;
  jobId: number | null;
  jobName: string | null;
  /** Null when an ingredient has no captured price, and for a non-craftable. */
  ingredientCost: number | null;
  /** Null when the item itself has no captured price. */
  sellPrice: number | null;
  /** Null whenever either side above is null. */
  profitPerUnit: number | null;
  marginPercent: number | null;
  /**
   * What one unit is worth recycled rather than sold: its nugget yield at the
   * craft bonus, priced off the nugget's own ladder. Null when the yield or the
   * nugget price is missing.
   *
   * The craft bonus is applied only when a recipe makes the item, which is the
   * rule all three measurements fit: Rune Invo has none and paid at x1, while
   * Multygely and the Essence both have one and paid at x1.5 and x1.5 x 3.
   */
  recycleValue: number | null;
}

interface RecipeRow extends Record<string, unknown> {
  item_id: string;
  ingredient_id: string;
  quantity: number;
  job_id: number;
  name_fr: string | null;
  level: number | null;
  icon_id: string | null;
}

interface RecycleRow extends Record<string, unknown> {
  item_id: string;
  name_fr: string | null;
  level: number | null;
  icon_id: string | null;
}

/**
 * Every candidate recipe already known to the database, plus every other
 * non-equipment item worth recycling.
 *
 * The second half is not an afterthought: a craft table only ever sees what a
 * job makes, and the things actually worth recycling are usually dropped or
 * gathered rather than crafted. Runes are the clearest case — five of them are
 * priced and they average a base of 19.4, higher than any other group here —
 * and the craft list excludes them by rule. So a row can now be a recycling
 * opportunity without being a craft one, with the cost and margin columns empty
 * because there is no recipe to cost.
 *
 * Reads only what `recipes`/`items`/`prices` already hold — it does not call
 * DofusDB. `loadJobLevelBand` below is the action that goes and gets more.
 */
export async function loadOpportunities(): Promise<{
  rows: OpportunityRow[];
  jobs: JobOption[];
  /** The nugget's own per-unit rate, so the page can show what it priced with. */
  nuggetPrice: number | null;
}> {
  const [recipeRows, recycleRows, jobs] = await Promise.all([
    query<RecipeRow>(
      `SELECT r.item_id, r.ingredient_id, r.quantity, r.job_id,
              i.name_fr, i.level, i.icon_id
         FROM recipes r
         JOIN items i ON i.item_id = r.item_id
        WHERE r.job_id IS NOT NULL
          AND i.super_type_id = ANY($1::smallint[])
          AND ${NOT_RUNE_SQL}
        ORDER BY r.item_id, r.position`,
      [NOT_STUFF_SUPER_TYPES],
    ),
    // Everything else a recycler takes: no recipe makes it, so it can never
    // reach the query above, but it has a yield and a captured price and the
    // sell-or-recycle question applies to it exactly the same. Runes included
    // deliberately — the craft list rules them out, and they are the best of
    // the lot. A yield of 0 is left out: there is nothing to compare.
    query<RecycleRow>(
      `SELECT i.item_id, i.name_fr, i.level, i.icon_id
         FROM items i
        WHERE i.super_type_id = ANY($1::smallint[])
          AND i.recycle_nuggets > 0
          AND EXISTS (SELECT 1 FROM prices p WHERE p.item_id = i.item_id)
          AND NOT EXISTS (SELECT 1 FROM recipes r
                           WHERE r.item_id = i.item_id AND r.job_id IS NOT NULL)`,
      [NOT_STUFF_SUPER_TYPES],
    ),
    craftJobs(),
  ]);

  const jobName = new Map(jobs.map((j) => [j.id, j.name]));

  interface Grouped {
    itemId: number;
    name: string;
    level: number | null;
    iconId: number | null;
    jobId: number;
    lines: { itemId: number; quantity: number }[];
  }
  const grouped = new Map<number, Grouped>();
  for (const r of recipeRows) {
    const itemId = Number(r.item_id);
    const g = grouped.get(itemId) ?? {
      itemId,
      name: r.name_fr ?? `Item ${itemId}`,
      level: r.level,
      iconId: r.icon_id === null ? null : Number(r.icon_id),
      jobId: r.job_id,
      lines: [],
    };
    g.lines.push({ itemId: Number(r.ingredient_id), quantity: r.quantity });
    grouped.set(itemId, g);
  }

  const allIds = new Set<number>([NUGGET_ITEM_ID]);
  for (const g of grouped.values()) {
    allIds.add(g.itemId);
    for (const line of g.lines) allIds.add(line.itemId);
  }
  for (const r of recycleRows) allIds.add(Number(r.item_id));

  // Both kinds of row, so one query covers the lot. An ingredient's own
  // recycling value is not this question, but including it costs nothing and
  // keeps the id list identical to the ladder lookup.
  const subjectIds = [...allIds];
  const [ladders, yieldRows] = await Promise.all([
    latestLadders(subjectIds),
    query<{ item_id: string; recycle_nuggets: string | number | null }>(
      `SELECT item_id, recycle_nuggets FROM items
        WHERE item_id = ANY($1::bigint[]) AND recycle_nuggets IS NOT NULL`,
      [subjectIds],
    ),
  ]);

  const nuggetLadder = ladders.get(NUGGET_ITEM_ID);
  const nuggetPrice = nuggetLadder ? unitPrice(nuggetLadder) : null;
  const perUnitYield = new Map(
    yieldRows.map((r) => [Number(r.item_id), Number(r.recycle_nuggets)]),
  );

  const rows: OpportunityRow[] = [...grouped.values()].map((g) => {
    let ingredientCost: number | null = 0;
    for (const line of g.lines) {
      const ladder = ladders.get(line.itemId);
      // The best per-unit rate on the ladder, not the plan for buying exactly
      // this recipe's small quantity: a craft usually needs 2-5 of a line,
      // and planBuy at that volume almost never reaches the x10/x100 batches
      // where the real discount lives. This assumes buying at the volume a
      // profitable craft run actually happens at, same reasoning as
      // `unitPrice` on the sell side below.
      const rate = ladder ? unitPrice(ladder) : null;
      if (rate === null) {
        ingredientCost = null;
      } else if (ingredientCost !== null) {
        ingredientCost += rate * line.quantity;
      }
    }

    const outputLadder = ladders.get(g.itemId);
    const sellPrice = outputLadder ? unitPrice(outputLadder) : null;

    const m =
      ingredientCost !== null && ingredientCost > 0 && sellPrice !== null
        ? margin(ingredientCost, sellPrice)
        : null;

    return {
      itemId: g.itemId,
      name: g.name,
      level: g.level,
      iconId: g.iconId,
      craftable: true,
      jobId: g.jobId,
      jobName: jobName.get(g.jobId) ?? null,
      ingredientCost,
      sellPrice,
      profitPerUnit: m?.profitPerUnit ?? null,
      marginPercent: m?.marginPercent ?? null,
      recycleValue: valueRecycled(g.itemId, true),
    };
  });

  for (const r of recycleRows) {
    const itemId = Number(r.item_id);
    const ladder = ladders.get(itemId);
    rows.push({
      itemId,
      name: r.name_fr ?? `Item ${itemId}`,
      level: r.level,
      iconId: r.icon_id === null ? null : Number(r.icon_id),
      craftable: false,
      jobId: null,
      jobName: null,
      ingredientCost: null,
      sellPrice: ladder ? unitPrice(ladder) : null,
      profitPerUnit: null,
      marginPercent: null,
      recycleValue: valueRecycled(itemId, false),
    });
  }

  return { rows, jobs, nuggetPrice };

  /** Kamas from recycling one unit. The craft bonus rides on having a recipe. */
  function valueRecycled(itemId: number, craftable: boolean): number | null {
    const base = perUnitYield.get(itemId);
    if (base === undefined || !Number.isFinite(base) || nuggetPrice === null) return null;
    const bonus = craftable ? RECYCLE_BONUSES.craft : 1;
    return base * bonus * CHARACTER_SHARE * nuggetPrice;
  }
}

/**
 * Pull one job's recipes in a level band from DofusDB into `recipes`/`items`,
 * same shape as the craft basket's bulk-add (`addJobRange` in basket.ts) but
 * without touching `craft_basket` — this only wants the recipes on the books,
 * not added to a shopping list.
 */
export async function loadJobLevelBand(
  jobId: number,
  minLevel: number,
  maxLevel: number,
): Promise<{ found: number; levels: [number, number] | null }> {
  const recipes = await jobRecipes(jobId, minLevel, maxLevel);
  if (recipes.length === 0) return { found: 0, levels: null };

  await rememberRecipes(recipes);
  // Named now rather than on the next page load, same reasoning as
  // loadJobCatalogue in broken.ts: an id with no name reads as "Item 10181"
  // until something asks DofusDB who it is.
  await fetchItems(recipes.map((r) => r.itemId));

  const levels = recipes.map((r) => r.level).filter((l) => l > 0);
  return {
    found: recipes.length,
    levels: levels.length > 0 ? [Math.min(...levels), Math.max(...levels)] : null,
  };
}
