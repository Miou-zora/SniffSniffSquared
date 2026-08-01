import { query } from "@/lib/db";
import type { BreakerView } from "@/lib/breaker";
import { profitPercent } from "@/lib/brisage";

/**
 * Is this item worth breaking?
 *
 * Computed from what its runes fetch against what a copy costs, and compared to
 * a threshold you set. A manual mark overrides it: the arithmetic knows the
 * runes and the market, it does not know that an item completes a set you are
 * keeping, or that the one listing left was a typo.
 */
export type Status = "worth" | "skip";

export interface Verdict {
  /** What to show. Null when neither side of the sum is known. */
  status: Status | null;
  /** Profit percent behind it, null when it could not be computed. */
  profit: number | null;
  /** True when a human said so and the arithmetic was overruled. */
  manual: boolean;
  /** What the automatic verdict would have been, when a manual one hides it. */
  automatic: Status | null;
  thresholdPercent: number;
  mode: Mode;
  /** Which side is missing, for a UI that has to explain itself. */
  missing: "value" | "cost" | null;
  /** Whether the cost used was the market price or the craft. */
  against: "market" | "craft" | null;
  /** True when no crush of this item fixed its coefficient. */
  assumed: boolean;
}

const THRESHOLD_KEY = "break_threshold_percent";
const MODE_KEY = "verdict_mode";
const DEFAULT_THRESHOLD = 15;

/**
 * `automatic` derives a verdict from the profit; `manual` shows one only where
 * you have set it. Manual marks win under both — the mode decides whether an
 * unmarked item gets an opinion at all.
 */
export type Mode = "automatic" | "manual";

export async function mode(): Promise<Mode> {
  const [row] = await query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [MODE_KEY],
  );
  return row?.value === "manual" ? "manual" : "automatic";
}

export async function setMode(next: Mode): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [MODE_KEY, next],
  );
}

export async function threshold(): Promise<number> {
  const [row] = await query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [THRESHOLD_KEY],
  );
  const v = Number.parseFloat(row?.value ?? "");
  return Number.isFinite(v) ? v : DEFAULT_THRESHOLD;
}

export async function setThreshold(percent: number): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [THRESHOLD_KEY, String(percent)],
  );
}

export async function markOf(itemId: number): Promise<Status | null> {
  const [row] = await query<{ status: string }>(
    `SELECT status FROM item_marks WHERE item_id = $1`,
    [itemId],
  );
  return row?.status === "worth" || row?.status === "skip" ? row.status : null;
}

export async function setMark(itemId: number, status: Status | null): Promise<void> {
  if (status === null) {
    await query(`DELETE FROM item_marks WHERE item_id = $1`, [itemId]);
    return;
  }
  await query(
    `INSERT INTO item_marks (item_id, status) VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [itemId, status],
  );
}

/** Every mark you have set, for the curated list. */
export async function allMarks(): Promise<Map<number, Status>> {
  const rows = await query<{ item_id: string; status: string }>(
    `SELECT item_id, status FROM item_marks`,
  );
  const out = new Map<number, Status>();
  for (const r of rows) {
    if (r.status === "worth" || r.status === "skip") out.set(Number(r.item_id), r.status);
  }
  return out;
}

/** Marks for many ids at once, for lists. */
export async function marksOf(itemIds: number[]): Promise<Map<number, Status>> {
  if (itemIds.length === 0) return new Map();
  const rows = await query<{ item_id: string; status: string }>(
    `SELECT item_id, status FROM item_marks WHERE item_id = ANY($1::bigint[])`,
    [itemIds],
  );
  const out = new Map<number, Status>();
  for (const r of rows) {
    if (r.status === "worth" || r.status === "skip") out.set(Number(r.item_id), r.status);
  }
  return out;
}

/**
 * The best kamas one crush yields at the coefficient in force.
 *
 * The better of focusing and not focusing, because that is what you would
 * actually do — judging the item by a focus you would not choose understates
 * it. Column 1 is the current coefficient; column 0 is the 100% ceiling.
 */
function bestYield(view: BreakerView): number | null {
  const focus = view.outcomes[0]?.value[1] ?? null;
  const none = view.noFocus.value[1] ?? null;
  if (focus === null && none === null) return null;
  return Math.max(focus ?? 0, none ?? 0);
}

/**
 * The verdict for an item, given everything already loaded for its page.
 *
 * Measured against the cheaper of buying a copy and making one, because those
 * are the two ways to get the item and you would take the cheaper. Judging
 * against the market alone overstates the case for breaking anything cheaper to
 * craft, which is most crafted gear.
 */
export async function verdictFor(view: BreakerView): Promise<Verdict> {
  const [thresholdPercent, current, manual] = await Promise.all([
    threshold(),
    mode(),
    markOf(view.item.itemId),
  ]);

  const value = bestYield(view);
  const options: [number, "market" | "craft"][] = [];
  if (view.projection.itemCost !== null)
    options.push([view.projection.itemCost, "market"]);
  if (view.projection.craft?.cost != null)
    options.push([view.projection.craft.cost, "craft"]);
  const cheapest =
    options.length === 0 ? null : options.reduce((a, b) => (b[0] < a[0] ? b : a));
  const cost = cheapest?.[0] ?? null;
  const profit = value === null || cost === null ? null : profitPercent(value, cost);
  // The profit is computed either way — under manual it is what the badge
  // reports next to your mark, so the number stays visible even when it is not
  // the thing deciding.
  // No crush of this item means no coefficient, and every rune figure scales
  // with it — a verdict resting on an assumed 100% is a guess wearing the
  // clothes of arithmetic. The profit is still shown, labelled, because seeing
  // it is what tells you whether finding out is worth a crush.
  const assumed = view.projection.coefficientAssumed;
  const automatic: Status | null =
    current === "manual" || profit === null || assumed
      ? null
      : profit >= thresholdPercent
        ? "worth"
        : "skip";

  return {
    status: manual ?? automatic,
    profit,
    manual: manual !== null,
    automatic,
    thresholdPercent,
    mode: current,
    missing: value === null ? "value" : cost === null ? "cost" : null,
    against: cheapest?.[1] ?? null,
    assumed,
  };
}
