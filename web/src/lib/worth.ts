import { query } from "@/lib/db";
import { marksOf, mode, threshold, type Status } from "@/lib/verdict";

export interface WorthRow {
  itemId: number;
  name: string;
  level: number | null;
  type: string | null;
  /** Kamas one crush yields, the better of focusing and not. */
  value: number;
  /** What a copy costs: cheapest listing, else the last stack quote. */
  cost: number;
  profit: number;
  /** The rune worth focusing, or null when crushing plain wins. */
  focus: string | null;
  /** True when a crush of this item fixed the coefficient; false when assumed. */
  observed: boolean;
  coefficient: number;
  status: Status;
  manual: boolean;
}

/**
 * Every item the data can judge, ranked by profit.
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
 * are computed at 100% and flagged. Their profit is an upper bound.
 */
export async function worthList(): Promise<{
  rows: WorthRow[];
  thresholdPercent: number;
  automatic: boolean;
}> {
  const [thresholdPercent, current] = await Promise.all([threshold(), mode()]);

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
     SELECT i.item_id, i.name_fr, i.level, i.type_fr,
            GREATEST(COALESCE(nf.value, 0), COALESCE(bf.value, 0)) AS value,
            COALESCE(oc.cost, sc.cost) AS cost,
            CASE WHEN COALESCE(bf.value, 0) > COALESCE(nf.value, 0)
                 THEN bf.rune END AS focus_rune,
            COALESCE(cf.yield_percent, 100) AS coefficient,
            cf.yield_percent IS NOT NULL AS observed
       FROM items i
       LEFT JOIN no_focus nf ON nf.item_id = i.item_id AND nf.priced
       LEFT JOIN best_focus bf ON bf.item_id = i.item_id
       LEFT JOIN offer_cost oc ON oc.item_id = i.item_id
       LEFT JOIN stack_cost sc ON sc.item_id = i.item_id
       LEFT JOIN coef cf ON cf.item_id = i.item_id
      WHERE COALESCE(oc.cost, sc.cost) > 0
        AND GREATEST(COALESCE(nf.value, 0), COALESCE(bf.value, 0)) > 0
        -- A rune carries an effect, so the weights view happily prices one as
        -- if it could be crushed. It cannot: it is what crushing produces.
        AND COALESCE(i.type_id, 0) <> 78`,
  );

  const marks = await marksOf(rows.map((r) => Number(r.item_id)));

  const out: WorthRow[] = [];
  for (const r of rows) {
    const itemId = Number(r.item_id);
    const value = Number(r.value);
    const cost = Number(r.cost);
    const profit = (value * 100) / cost - 100;
    const manual = marks.get(itemId) ?? null;
    const automatic: Status | null =
      current === "manual" ? null : profit >= thresholdPercent ? "worth" : "skip";
    const status = manual ?? automatic;
    if (status === null) continue;

    out.push({
      itemId,
      name: r.name_fr ?? `Item ${itemId}`,
      level: r.level,
      type: r.type_fr,
      value,
      cost,
      profit,
      focus: r.focus_rune,
      observed: r.observed,
      coefficient: Number(r.coefficient),
      status,
      manual: manual !== null,
    });
  }

  out.sort((a, b) => b.profit - a.profit);
  return { rows: out, thresholdPercent, automatic: current === "automatic" };
}
