/**
 * Writing recipes down.
 *
 * Its own module rather than a function on `basket.ts`, because both sides of
 * the app learn recipes now: the bulk job loads that `basket.ts` and
 * `opportunities.ts` drive, and `breaker.ts`, which learns one at a time when
 * you open an item it has never seen. `basket.ts` already imports `breaker.ts`,
 * so putting it in either would be a runtime import cycle.
 */
import { query } from "@/lib/db";

/**
 * The least a recipe needs to be stored. `JobRecipe` is structurally
 * assignable, so the bulk loaders pass theirs straight in.
 *
 * `jobId` is not optional on purpose: `/opportunities` lists what a job makes
 * and filters on `job_id IS NOT NULL`, so a recipe stored without one is
 * written and then invisible — which reads exactly like it was never stored.
 */
export interface StoredRecipe {
  itemId: number;
  jobId: number;
  ingredients: { itemId: number; quantity: number }[];
}

/**
 * Keep these recipes.
 *
 * Same table and same shape as tools/import_items.py writes, and replaced
 * wholesale for the same reason: an ingredient dropped between game versions
 * has to lose its row rather than linger next to the new one.
 */
export async function rememberRecipes(recipes: StoredRecipe[]): Promise<void> {
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
      tuples.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5})`);
      values.push(recipe.itemId, position, ing.itemId, ing.quantity, recipe.jobId);
    });
  }
  await query(
    `INSERT INTO recipes (item_id, position, ingredient_id, quantity, job_id)
     VALUES ${tuples.join(",")}
     ON CONFLICT (item_id, position) DO UPDATE SET
       ingredient_id = EXCLUDED.ingredient_id, quantity = EXCLUDED.quantity,
       job_id = EXCLUDED.job_id`,
    values,
  );
}
