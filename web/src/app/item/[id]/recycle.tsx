import { CHARACTER_SHARE, RECYCLE_BONUSES, type RecycleYield } from "@/lib/recycle";

const nuggets = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
/** Small yields are hundredths of a nugget; two digits rounds them to nothing. */
const precise = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 });

/**
 * What recycling this item pays.
 *
 * Leads with the payout rather than the base, because the payout is the figure
 * the game shows you and the one you would check this page against. The base
 * is next to it, since that is the number that stays true when your share or
 * your standing changes.
 */
export function RecycleYieldPanel({ yield: y }: { yield: RecycleYield | null }) {
  if (y === null) {
    return (
      <p className="text-body tracking-body text-sage-40 max-w-[74ch]">
        Nothing known about recycling this item — DofusDB was asked directly.
      </p>
    );
  }

  if (y.base === 0) {
    return (
      <p className="text-body tracking-body text-sage-40 max-w-[74ch]">
        <span className="text-phosphor-white">No recycling value</span> in the game data.
        Most of the catalogue reads this way — whether that means the recycler refuses the
        item or that the figure is simply absent has not been established, so this is what
        the source says rather than a verdict.
      </p>
    );
  }

  const fmt = y.perUnit < 0.1 ? precise : nuggets;

  return (
    <p className="text-body tracking-body text-sage-40 max-w-[74ch]">
      <span className="text-phosphor-white tabular-nums">{fmt.format(y.perUnit)}</span>{" "}
      nuggets per unit, at your {Math.round(CHARACTER_SHARE * 100)}% character share of a
      base <span className="tabular-nums">{precise.format(y.base)}</span>.{" "}
      <span className="tabular-nums">
        {fmt.format(y.perUnit * 10)} for 10, {fmt.format(y.perUnit * 100)} for 100
      </span>
      .
      <span className="text-deep-fern block">
        Before bonuses: x{RECYCLE_BONUSES.zone} in one of the item&apos;s favourite
        subareas, x{RECYCLE_BONUSES.craft} for something you crafted yourself, x
        {RECYCLE_BONUSES.boss} on boss loot. They multiply the base, so the whole readout
        scales with them.
      </span>
    </p>
  );
}
