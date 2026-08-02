/**
 * One item's price over time.
 *
 * `prices` has always been a time series — one row per observation, never
 * overwritten — and until now every reader took `DISTINCT ON … ORDER BY seen_at
 * DESC` and threw the rest away. A rune's x1 price is what every rune figure in
 * this app multiplies by, so whether that number has been drifting is worth
 * seeing rather than assuming.
 *
 * Two series shapes, because the market has two: a stack quote per batch size
 * for fungible things, and individual listings for gear. An item has one or the
 * other, essentially never both.
 */
import { fetchItems } from "@/lib/breaker";
import { query } from "@/lib/db";

/** One captured ladder, as it stood at `at`. Prices are per batch, in kamas. */
export interface LadderPoint {
  /** ISO — the client formats it, the server's timezone is not the reader's. */
  at: string;
  b1: number;
  b10: number;
  b100: number;
  b1000: number;
}

/** The cheapest listing on the market at `at`, and how many were up. */
export interface OfferPoint {
  at: string;
  cheapest: number;
  listings: number;
}

export interface HistoryView {
  item: {
    itemId: number;
    name: string;
    level: number | null;
    type: string | null;
    iconId: number | null;
  };
  ladder: LadderPoint[];
  offers: OfferPoint[];
}

export async function priceHistory(itemId: number): Promise<HistoryView | null> {
  const [meta] = await query<{
    name_fr: string | null;
    level: number | null;
    type_fr: string | null;
    icon_id: string | null;
  }>(`SELECT name_fr, level, type_fr, icon_id FROM items WHERE item_id = $1`, [itemId]);

  const [ladderRows, offerRows] = await Promise.all([
    query<{ seen_at: Date; b1: string; b10: string; b100: string; b1000: string }>(
      // Rows where every size reads 0 are a capture in which nothing was on
      // sale. They are not a price of zero and would drag a line to the floor.
      `SELECT seen_at, b1, b10, b100, b1000 FROM prices
        WHERE item_id = $1 AND (b1 > 0 OR b10 > 0 OR b100 > 0 OR b1000 > 0)
        ORDER BY seen_at`,
      [itemId],
    ),
    // Every listing in one panel lands in the same instant, so a snapshot is a
    // second's worth of rows: the cheapest of those is what the item cost then.
    query<{ at: Date; cheapest: string; listings: string }>(
      `SELECT date_trunc('second', seen_at) AS at,
              min(price) AS cheapest, count(*) AS listings
         FROM offers WHERE item_id = $1
        GROUP BY 1 ORDER BY 1`,
      [itemId],
    ),
  ]);

  let name = meta?.name_fr ?? null;
  let level = meta?.level ?? null;
  let type = meta?.type_fr ?? null;
  let iconId =
    meta?.icon_id === undefined || meta.icon_id === null ? null : Number(meta.icon_id);

  // An id the market has quoted but nothing has ever named — a rune whose page
  // nobody opened. Ask once; the answer caches into `items` like every other.
  if (name === null || iconId === null) {
    const fetched = (await fetchItems([itemId])).get(itemId);
    if (fetched) {
      name = name ?? fetched.name;
      level = level ?? fetched.level;
      type = type ?? fetched.type;
      iconId = iconId ?? fetched.iconId;
    }
  }

  if (name === null && ladderRows.length === 0 && offerRows.length === 0) return null;

  return {
    item: { itemId, name: name ?? `Item ${itemId}`, level, type, iconId },
    ladder: ladderRows.map((r) => ({
      at: r.seen_at.toISOString(),
      b1: Number(r.b1),
      b10: Number(r.b10),
      b100: Number(r.b100),
      b1000: Number(r.b1000),
    })),
    offers: offerRows.map((r) => ({
      at: r.at.toISOString(),
      cheapest: Number(r.cheapest),
      listings: Number(r.listings),
    })),
  };
}
