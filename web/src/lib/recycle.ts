/**
 * Recycling an item into nuggets ("pépites").
 *
 * The yield is static client data. It never crosses the wire, so unlike prices
 * there is nothing here for the sniffer to capture: the recycler message the
 * client sends (`kcr`) is a placement delta and an instance uid, seven bytes
 * fully accounted for, and the whole packet archive holds no float or scaled
 * integer matching an observed payout. The client works it out on screen from
 * its own asset bundle.
 *
 * It does not simply read the item's `recyclingNuggets` field, which is why the
 * first attempt at this was wrong: that field is 0 for all 4511 craftable items,
 * and `RecycleUi.GetItemNuggets` takes a `Dictionary<int, int> resources` rather
 * than an item. A craftable is decomposed into resources and summed;
 * `items.recycle_nuggets` holds the result, filled by tools/extract_nuggets.py
 * straight from the client's data files. DofusDB mirrors the raw field
 * faithfully — bit for bit — but the raw field is only half the answer.
 *
 * That column is the *base* for one unit, before any of the below.
 */
import { fetchItems } from "@/lib/breaker";
import { query } from "@/lib/db";
import { NOT_STUFF_SUPER_TYPES } from "@/lib/kind";

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

/**
 * Why equipment gets no figure here.
 *
 * The decomposition lands within display rounding on every consumable and
 * resource measured, and on both pieces of equipment it does not:
 *
 *   Rune Invo      own 4.5      x1    x0.6 =  2.7000  shown 2,70    exact
 *   Multygely      leaf 0.50596 x1.5  x0.6 =  0.4554  shown 0,46    rounding
 *   Essence CL     leaf 0.20971 x4.5  x0.6 =  0.5662  shown 0,57    rounding
 *   Gelano         leaf 5.20199 x1.5  x0.6 =  4.68    shown 5,32    +13.6%
 *   Marteau Ridhe  leaf 36.5241 x1.5  x0.6 = 32.87    shown 33,69   +2.5%
 *
 * Stat quality was the obvious candidate and does not fit: the Marteau rolled
 * 8.9% above its template weighted, four times the gap it has to explain, and
 * the Gelano's only templated line is fixed at 1 so it cannot roll high at all.
 * Rather than print a number that is wrong by an unknown amount for gear, the
 * panel says so. Whatever the missing factor is, it is not in the item data.
 */
export type RecycleYield =
  /** Gear. Known to be modelled wrong, so no figure is offered. */
  { kind: "equipment" } | RecycleAmount;

export interface RecycleAmount {
  kind: "amount";
  /** Nuggets per unit before bonuses and the split, as the game data holds it. */
  base: number;
  /** What one unit pays out at `CHARACTER_SHARE` with no bonus active. */
  perUnit: number;
  /**
   * The same at the x1.5 craft bonus, or null for an item no recipe makes.
   *
   * What a craftable item was measured paying: Multygely decomposes to 0.5060
   * and showed 0,46, which is this figure and not `perUnit`. Shown alongside
   * rather than instead, because whether the bonus keys off "this item has a
   * recipe" or "you crafted this copy" has not been separated — and null rather
   * than computed for the rest, since Rune Invo has no recipe and a craft bonus
   * next to it is a number that can never occur.
   */
  perUnitCrafted: number | null;
}

/**
 * One item's recycling yield, `{ kind: "equipment" }` for gear the model does
 * not cover, or null when nothing is known about it.
 *
 * Reads the stored constant first and falls back to DofusDB for an item the
 * importer has never reached — `fetchItems` writes what it learns, so the
 * second view of that item finds the row and asks nobody. Same lazy-enrichment
 * rule the rest of the app uses.
 *
 * DofusDB is a weaker source than the table here, not an equal one: it serves
 * the raw `recyclingNuggets` field, which is 0 for every craftable item because
 * the client decomposes those into resources instead of reading it. So a zero
 * from DofusDB is discarded rather than stored — it would overwrite a
 * decomposed value with a number that reads as "not worth recycling".
 * tools/extract_nuggets.py is what fills those in.
 */
export async function recycleYield(itemId: number): Promise<RecycleYield | null> {
  // Subqueries rather than a join, so the row comes back even for an item that
  // `items` has never heard of — the DofusDB fallback below needs to run, and
  // whether a recipe makes it is a separate fact from whether it is named.
  const rows = await query<{
    recycle_nuggets: string | number | null;
    craftable: boolean;
    equipment: boolean;
  }>(
    `SELECT (SELECT recycle_nuggets FROM items WHERE item_id = $1) AS recycle_nuggets,
            EXISTS (SELECT 1 FROM recipes WHERE item_id = $1) AS craftable,
            -- NOT NULL matters: an item nothing has named yet is unknown, not
            -- equipment, and must fall through to the DofusDB lookup below.
            NOT COALESCE((SELECT super_type_id = ANY($2::smallint[])
                            FROM items WHERE item_id = $1), true) AS equipment`,
    [itemId, NOT_STUFF_SUPER_TYPES],
  );
  if (rows[0]?.equipment) return { kind: "equipment" };

  // `pg` hands back DOUBLE PRECISION as a number, but a string on some driver
  // versions; Number() covers both. The null check is not redundant with it —
  // `Number(null)` is 0, which would report every item the importer has not
  // reached yet as one the recycler refuses.
  const stored = rows[0]?.recycle_nuggets;
  let base = stored === undefined || stored === null ? Number.NaN : Number(stored);

  if (!Number.isFinite(base)) {
    const meta = await fetchItems([itemId]);
    const live = meta.get(itemId)?.recycleNuggets;
    // A live 0 is not an answer — see the note above — so it stays unknown
    // rather than becoming a stored zero.
    if (live === undefined || live === null || live === 0) return null;
    base = live;
  }

  return {
    kind: "amount",
    base,
    perUnit: base * CHARACTER_SHARE,
    perUnitCrafted: rows[0]?.craftable
      ? base * RECYCLE_BONUSES.craft * CHARACTER_SHARE
      : null,
  };
}
