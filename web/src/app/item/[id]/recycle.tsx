import { CHARACTER_SHARE, RECYCLE_BONUSES, type RecycleYield } from "@/lib/recycle";

const nuggets = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
/** Small yields are hundredths of a nugget; two digits rounds them to nothing. */
const precise = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 });

/**
 * What recycling this item pays.
 *
 * Two figures rather than one, because the bonus that separates them is not a
 * property of the item and cannot be resolved from stored data: the plain
 * payout, and the same with the craft bonus, which is what every craftable item
 * measured so far has actually paid. Picking one and printing it alone would be
 * wrong half the time with nothing on screen to say so.
 */
export function RecycleYieldPanel({ yield: y }: { yield: RecycleYield | null }) {
  if (y === null) {
    return (
      <p className="text-body tracking-body text-sage-40 max-w-[74ch]">
        Nothing known about recycling this item. DofusDB serves 0 for anything craftable,
        so that is not an answer either — run{" "}
        <code className="text-deep-fern">tools/extract_nuggets.py</code>, which reads the
        yield out of the client&apos;s own data files.
      </p>
    );
  }

  if (y.kind === "equipment") {
    return (
      <p className="text-body tracking-body text-sage-40 max-w-[74ch]">
        <span className="text-phosphor-white">Not modelled for equipment.</span> The
        decomposition matches every consumable and resource measured, and misses on gear —
        a Gelano by 13.6% and a Marteau Ridhe by 2.5%, in the same direction but not by
        the same factor, and not by stat quality either. A number that is wrong by an
        unknown amount is worse here than no number.
      </p>
    );
  }

  if (y.base === 0) {
    return (
      <p className="text-body tracking-body text-sage-40 max-w-[74ch]">
        <span className="text-phosphor-white">No recycling value.</span> The item has none
        of its own and no recipe to decompose, which is the case for 22 items in the
        catalogue.
      </p>
    );
  }

  const fmt = y.perUnit < 0.1 ? precise : nuggets;

  return (
    <p className="text-body tracking-body text-sage-40 max-w-[74ch]">
      <span className="text-phosphor-white tabular-nums">{fmt.format(y.perUnit)}</span>{" "}
      nuggets per unit
      {y.perUnitCrafted !== null && (
        <>
          , or{" "}
          <span className="text-phosphor-white tabular-nums">
            {fmt.format(y.perUnitCrafted)}
          </span>{" "}
          with the craft bonus
        </>
      )}{" "}
      — at your {Math.round(CHARACTER_SHARE * 100)}% character share of a base{" "}
      <span className="tabular-nums">{precise.format(y.base)}</span>.
      <span className="text-deep-fern block">
        The base multiplies by {RECYCLE_BONUSES.zone} in one of the item&apos;s favourite
        subareas, {RECYCLE_BONUSES.craft} for a craft, and {RECYCLE_BONUSES.boss} on boss
        loot, and these combine. Measured: Rune Invo pays{" "}
        <span className="tabular-nums">2,70</span> with none of them, Multygely{" "}
        <span className="tabular-nums">0,46</span> at the craft bonus, and the Essence du
        Craqueleur Légendaire <span className="tabular-nums">0,57</span> at craft x boss.
      </span>
    </p>
  );
}
