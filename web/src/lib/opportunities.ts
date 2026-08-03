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
import { margin, planBuy, unitPrice } from "@/lib/craft";
import { query } from "@/lib/db";

/**
 * DofusDB `item.type.superTypeId` values that are NOT equipment: Consommable
 * (6), Ressource (9), Nourriture (16), Consommables de combat (70). A
 * whitelist rather than a deny-list of every weapon/armor slot, so a new
 * equipment category the game adds later costs nothing here — only a new
 * edible/usable category would need adding.
 *
 * Verified against https://api.dofusdb.fr/item-super-types.
 */
const NOT_STUFF_SUPER_TYPES = [6, 9, 16, 70];

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
  jobId: number;
  jobName: string | null;
  /** Null when an ingredient has no captured price. */
  ingredientCost: number | null;
  /** Null when the item itself has no captured price. */
  sellPrice: number | null;
  /** Null whenever either side above is null. */
  profitPerUnit: number | null;
  marginPercent: number | null;
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

/**
 * Every candidate recipe already known to the database: a job crafts it, its
 * output passes the not-stuff whitelist, and it is not a rune. Ingredient
 * lines are grouped per item, then priced in one batch pass.
 *
 * Reads only what `recipes`/`items` already hold — it does not call DofusDB.
 * `loadJobLevelBand` below is the action that goes and gets more.
 */
export async function loadOpportunities(): Promise<{
  rows: OpportunityRow[];
  jobs: JobOption[];
}> {
  const [recipeRows, jobs] = await Promise.all([
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

  const allIds = new Set<number>();
  for (const g of grouped.values()) {
    allIds.add(g.itemId);
    for (const line of g.lines) allIds.add(line.itemId);
  }
  const ladders = await latestLadders([...allIds]);

  const rows: OpportunityRow[] = [...grouped.values()].map((g) => {
    let ingredientCost: number | null = 0;
    for (const line of g.lines) {
      const ladder = ladders.get(line.itemId);
      const plan = ladder ? planBuy(line.quantity, ladder) : null;
      if (plan === null) {
        ingredientCost = null;
      } else if (ingredientCost !== null) {
        ingredientCost += plan.cost;
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
      jobId: g.jobId,
      jobName: jobName.get(g.jobId) ?? null,
      ingredientCost,
      sellPrice,
      profitPerUnit: m?.profitPerUnit ?? null,
      marginPercent: m?.marginPercent ?? null,
    };
  });

  return { rows, jobs };
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
