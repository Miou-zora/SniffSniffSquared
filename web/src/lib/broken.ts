/**
 * Which equipment has been broken, and which has not.
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
import { query } from "@/lib/db";
import type { Status } from "@/lib/verdict";

export interface BrokenRow {
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
}

export interface BrokenView {
  rows: BrokenRow[];
  broken: number;
}

/**
 * Runes and percepteur gear carry stat lines and are not things you break for a
 * coefficient, so they are not part of the count.
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

export async function brokenList(): Promise<BrokenView> {
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

  const out: BrokenRow[] = rows.map((r) => ({
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
  }));

  return { rows: out, broken: out.filter((r) => r.crushes > 0).length };
}
