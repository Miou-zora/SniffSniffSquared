import { query } from "@/lib/db";
import {
  coefficientColumns,
  focusOutcomes,
  noFocusOutcome,
  weighLines,
  type CoefficientColumn,
  type FocusOutcome,
  type StatLine,
  type WeightedLine,
} from "@/lib/brisage";

export interface BreakerView {
  item: { itemId: number; name: string; level: number; type: string | null };
  uid: number | null;
  placedAt: Date;
  /** Every line the wire reported, rune-mapped or not. */
  lines: StatLine[];
  /** Only the lines that yield a rune, with weights. */
  weighted: WeightedLine[];
  totalWeight: number;
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
  if (uid === null) {
    const [fallback] = await query<{ uid: string }>(
      `SELECT uid FROM item_stats WHERE item_id = $1 ORDER BY seen_at DESC LIMIT 1`,
      [itemId],
    );
    uid = fallback ? Number(fallback.uid) : null;
  }

  const [itemRow] = await query<ItemRow>(
    `SELECT item_id, name_fr, level, type_fr FROM items WHERE item_id = $1`,
    [itemId],
  );

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

  const level = itemRow?.level ?? 1;
  const weighted = weighLines(lines, level).sort((a, b) => b.weight - a.weight);
  const totalWeight = weighted.reduce((s, l) => s + l.weight, 0);
  const unmapped = lines.filter((l) => l.rune === null);

  // The coefficient is account state, not item state: it decays as you craft.
  // The most recent crush is the best observation of it available.
  const [coeffRow] = await query<{ yield_percent: number }>(
    `SELECT yield_percent FROM crushes ORDER BY seen_at DESC, id DESC LIMIT 1`,
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

  const [costRow] = await latestPrices([itemId]).then((m) => [m.get(itemId) ?? null]);

  return {
    item: {
      itemId,
      name: itemRow?.name_fr ?? `Item ${itemId}`,
      level,
      type: itemRow?.type_fr ?? null,
    },
    uid,
    placedAt: placement.placed_at,
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
  };
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
