/**
 * The catalogue: every breakable item, and whether its coefficient has ever
 * been measured.
 *
 * The coefficient is per item type and the only way to learn one is to break a
 * copy — no amount of browsing tells you what a Kwape de Glace yields. So the
 * useful question is not "what did I break" but its inverse: what is still
 * unmeasured, and therefore still guesswork on every other page.
 *
 * Scope is the equipment this database knows a template for: an item whose
 * lines map to runes. That is what `item_break_weight` counts, and it is also
 * what "breakable" means — a template with no rune lines yields nothing.
 */
import { craftJobs, jobRecipes, rememberRecipes, type JobRecipe } from "@/lib/basket";
import { fetchItems } from "@/lib/breaker";
import { query } from "@/lib/db";
import type { Status } from "@/lib/verdict";

export interface CoverageRow {
  itemId: number;
  name: string;
  level: number | null;
  type: string | null;
  iconId: number | null;
  /** How many crushes of this item type were captured. 0 is the whole point. */
  crushes: number;
  /** The newest reading, null when it has never been broken. */
  coefficient: number | null;
  /** When that was, ISO. Null with no crush. */
  crushedAt: string | null;
  /** True when the wire has ever described a copy you held. */
  held: boolean;
  /** Your verdict, when you set one. */
  mark: Status | null;
  /** The job that crafts it, null when nothing does. */
  jobId: number | null;
  jobName: string | null;
}

export interface CoverageView {
  rows: CoverageRow[];
  broken: number;
  /** Every craft job, for the filter and for the catalogue loader. */
  jobs: { id: number; name: string }[];
}

/** DofusDB serves 50 rows a request whatever `$limit` says. */
const PAGE = 50;

/**
 * Which job makes each item, `recipes` first and DofusDB for the rest.
 *
 * The answer is cached back as a whole recipe rather than as a loose job id:
 * the recipe is what has a job, and writing it means the craft basket stops
 * having to ask for the same one later. Batched 50 at a time — a catalogue of
 * three hundred items is six requests, not three hundred.
 */
async function jobsFor(itemIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (itemIds.length === 0) return out;

  const known = await query<{ item_id: string; job_id: number | null }>(
    `SELECT DISTINCT item_id, job_id FROM recipes
      WHERE item_id = ANY($1::bigint[]) AND job_id IS NOT NULL`,
    [itemIds],
  );
  for (const row of known) {
    if (row.job_id !== null) out.set(Number(row.item_id), row.job_id);
  }

  const missing = itemIds.filter((id) => !out.has(id));
  const learned: JobRecipe[] = [];
  for (let i = 0; i < missing.length; i += PAGE) {
    const chunk = missing.slice(i, i + PAGE);
    try {
      const url =
        `https://api.dofusdb.fr/recipes?$limit=${PAGE}` +
        chunk.map((id) => `&resultId[$in][]=${id}`).join("") +
        `&$select[]=resultId&$select[]=resultLevel&$select[]=jobId` +
        `&$select[]=ingredientIds&$select[]=quantities`;
      const res = await fetch(url, {
        next: { revalidate: 604_800 },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const body: unknown = await res.json();
      const data = (body as { data?: unknown }).data;
      if (!Array.isArray(data)) continue;
      for (const raw of data) {
        const r = raw as {
          resultId?: unknown;
          resultLevel?: unknown;
          jobId?: unknown;
          ingredientIds?: unknown;
          quantities?: unknown;
        };
        const itemId = Number(r.resultId);
        const jobId = Number(r.jobId);
        if (!Number.isFinite(itemId) || !Number.isFinite(jobId)) continue;
        out.set(itemId, jobId);
        const ids = r.ingredientIds;
        const quantities = r.quantities;
        if (!Array.isArray(ids) || !Array.isArray(quantities)) continue;
        if (ids.length === 0 || ids.length !== quantities.length) continue;
        learned.push({
          itemId,
          level: Number(r.resultLevel) || 0,
          jobId,
          ingredients: ids.map((id, j) => ({
            itemId: Number(id),
            quantity: Number(quantities[j]),
          })),
        });
      }
    } catch {
      // A job label is a nicety; the coverage figure does not depend on it.
    }
  }
  if (learned.length > 0) await rememberRecipes(learned);
  return out;
}

/**
 * Runes and percepteur gear carry stat lines and are not things you break for a
 * coefficient, so they are not part of the count.
 *
 * `isBreakableKind` in lib/kind.ts is this same rule for one item at a time —
 * change them together.
 *
 * Every test is wrapped in COALESCE, and that is not decoration: `type_id` is
 * NULL on everything the read-side cache resolved — the offline importer is the
 * only thing that fills it — so `type_id = 78` is NULL there, `NOT (NULL OR …)`
 * is NULL, and the row silently vanishes. That cut the list from 331 items to
 * 18 and looked like a small catalogue rather than a bug.
 */
const IS_EQUIPMENT = `NOT COALESCE(i.type_id = 78, false)
      AND NOT COALESCE(i.type_fr LIKE 'Rune%', false)
      AND NOT COALESCE(i.type_fr = 'Fers de Percepteur', false)`;

/**
 * Pull a job's whole catalogue into the database.
 *
 * This page can only list what the database knows, and what it knows is
 * whatever happened to be browsed, held or imported — twelve Sculpteur items
 * against the 289 the job actually makes. That is not coverage, it is a
 * sample, and a sample cannot answer "what have I not broken".
 *
 * So the catalogue is fetched on demand, per job: every recipe, then the items
 * they make. Both are written down — recipes with their job, items with their
 * name, level, icon and template ranges — so the question is asked of DofusDB
 * once and of Postgres forever after.
 */
export async function loadJobCatalogue(
  jobId: number,
): Promise<{ recipes: number; items: number }> {
  const recipes = await jobRecipes(jobId, 1, 200);
  if (recipes.length === 0) return { recipes: 0, items: 0 };
  await rememberRecipes(recipes);
  // fetchItems writes names, levels, icons and the template ranges, and it is
  // the ranges that decide whether an item is breakable at all — without them
  // the rows would arrive and then be filtered straight back out.
  const meta = await fetchItems(recipes.map((r) => r.itemId));
  return { recipes: recipes.length, items: meta.size };
}

export async function coverage(): Promise<CoverageView> {
  const rows = await query<{
    item_id: string;
    name_fr: string | null;
    level: number | null;
    type_fr: string | null;
    icon_id: string | null;
    crushes: string;
    coefficient: string | null;
    crushed_at: Date | null;
    held: boolean;
    mark: string | null;
  }>(
    `WITH last_crush AS (
       SELECT DISTINCT ON (item_id) item_id, yield_percent, seen_at
         FROM crushes WHERE item_id IS NOT NULL
        ORDER BY item_id, seen_at DESC, id DESC
     ),
     crush_count AS (
       SELECT item_id, count(*) AS n FROM crushes
        WHERE item_id IS NOT NULL GROUP BY item_id
     )
     SELECT i.item_id, i.name_fr, i.level, i.type_fr, i.icon_id,
            COALESCE(c.n, 0) AS crushes,
            lc.yield_percent AS coefficient,
            lc.seen_at AS crushed_at,
            EXISTS (SELECT 1 FROM item_stats s WHERE s.item_id = i.item_id) AS held,
            m.status AS mark
       FROM items i
       JOIN item_break_weight w ON w.item_id = i.item_id AND w.rune_lines > 0
       LEFT JOIN crush_count c ON c.item_id = i.item_id
       LEFT JOIN last_crush lc ON lc.item_id = i.item_id
       LEFT JOIN item_marks m ON m.item_id = i.item_id
      WHERE ${IS_EQUIPMENT}
      ORDER BY i.level NULLS LAST, i.name_fr`,
  );

  const out: CoverageRow[] = rows.map((r) => ({
    itemId: Number(r.item_id),
    name: r.name_fr ?? `Item ${r.item_id}`,
    level: r.level,
    type: r.type_fr,
    iconId: r.icon_id === null ? null : Number(r.icon_id),
    crushes: Number(r.crushes),
    coefficient: r.coefficient === null ? null : Number(r.coefficient),
    crushedAt: r.crushed_at === null ? null : r.crushed_at.toISOString(),
    held: r.held,
    mark: r.mark === "worth" || r.mark === "skip" ? r.mark : null,
    jobId: null,
    jobName: null,
  }));

  // Icons for the rows that have never been drawn anywhere else. Cached back
  // into `items`, so this is one round trip per item ever rather than per view,
  // and it is what keeps the left of the table from being a column of blanks.
  const iconless = out.filter((r) => r.iconId === null).map((r) => r.itemId);
  const [byItem, jobs, icons] = await Promise.all([
    jobsFor(out.map((r) => r.itemId)),
    craftJobs(),
    fetchItems(iconless),
  ]);
  for (const row of out) {
    if (row.iconId === null) row.iconId = icons.get(row.itemId)?.iconId ?? null;
  }
  const jobName = new Map(jobs.map((j) => [j.id, j.name]));
  for (const row of out) {
    row.jobId = byItem.get(row.itemId) ?? null;
    row.jobName = row.jobId === null ? null : (jobName.get(row.jobId) ?? null);
  }

  // Every job, not only the ones already represented: picking one the database
  // has nothing for is how you find out it has nothing for it, and the page
  // offers to go and get it.
  return {
    rows: out,
    broken: out.filter((r) => r.crushes > 0).length,
    jobs,
  };
}
