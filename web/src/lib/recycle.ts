/**
 * Recycling an item into nuggets ("pépites").
 *
 * The yield is static client data. It never crosses the wire, so unlike prices
 * there is nothing here for the sniffer to capture: the recycler message the
 * client sends (`kcr`) is a placement delta and an instance uid, seven bytes
 * fully accounted for, and the whole packet archive holds no float or scaled
 * integer matching an observed payout. The client reads a constant from its own
 * asset bundle and does the arithmetic on screen.
 *
 * That constant is `items.recycle_nuggets`, from DofusDB — which serves the
 * identical double the client's bundle holds, checked bit for bit rather than
 * to a rounding. It is the *base* for one unit, before any of the below.
 */
import { fetchItems } from "@/lib/breaker";
import { query } from "@/lib/db";

/**
 * The multipliers the client applies, from `RecycleUi` in the game assembly —
 * one of the few classes the obfuscator left readable.
 *
 * None of them are properties of the item, so none are stored against one: they
 * depend on where you are standing, what you recycled, and whether a boss was
 * involved. They are listed so the panel can say what a figure does *not*
 * include.
 */
export const RECYCLE_BONUSES = {
  /** Recycling inside one of the item's `favoriteRecyclingSubareas`. */
  zone: 1.5,
  /** Recycling something you crafted yourself. */
  craft: 1.5,
  /** Boss loot. */
  boss: 3,
} as const;

/**
 * The share of the yield that reaches your character; the rest goes to the
 * alliance.
 *
 * Measured, not read out of the client: Rune Invo has a base of 4.5 and paid
 * 2.70, which is 60% exactly. Kept as a named constant because it is the one
 * number here that can differ per account — if your payouts stop matching,
 * this is the figure to change, and everything else on the page follows it.
 */
export const CHARACTER_SHARE = 0.6;

export interface RecycleYield {
  /** Nuggets per unit before bonuses and the split, as the game data holds it. */
  base: number;
  /** What one unit actually pays out at `CHARACTER_SHARE`, no bonus active. */
  perUnit: number;
}

/**
 * One item's recycling yield, or null when nothing is known about it.
 *
 * Reads the stored constant first and falls back to DofusDB for an item the
 * importer has never reached — `fetchItems` writes what it learns, so the
 * second view of that item finds the row and asks nobody. Same lazy-enrichment
 * rule the rest of the app uses.
 *
 * A base of 0 is not "unknown" — it is what the game data holds, for roughly
 * nine items in ten — so it comes back as a yield of zero rather than null. Not
 * read as "the recycler refuses it": a level 114 hammer reads 0 the same as a
 * quest token does, and telling a real refusal from an absent figure would need
 * a probe that costs an item. The panel reports the source, not a verdict.
 */
export async function recycleYield(itemId: number): Promise<RecycleYield | null> {
  const rows = await query<{ recycle_nuggets: string | number | null }>(
    `SELECT recycle_nuggets FROM items WHERE item_id = $1`,
    [itemId],
  );

  // `pg` hands back DOUBLE PRECISION as a number, but a string on some driver
  // versions; Number() covers both. The null check is not redundant with it —
  // `Number(null)` is 0, which would report every item the importer has not
  // reached yet as one the recycler refuses.
  const stored = rows[0]?.recycle_nuggets;
  let base = stored === undefined || stored === null ? Number.NaN : Number(stored);

  if (!Number.isFinite(base)) {
    const meta = await fetchItems([itemId]);
    const live = meta.get(itemId)?.recycleNuggets;
    if (live === undefined || live === null) return null;
    base = live;
  }

  return { base, perUnit: base * CHARACTER_SHARE };
}
