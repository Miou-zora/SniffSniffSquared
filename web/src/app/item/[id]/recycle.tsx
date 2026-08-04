import type { RecycleYield } from "@/lib/recycle";

const nuggets = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
/** Small yields are hundredths of a nugget; two digits rounds them to nothing. */
const precise = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 });

/**
 * What recycling this item pays, as one muted line.
 *
 * Renders nothing at all unless there is a figure — no heading, no section, and
 * no explanation of the model. Equipment, an item with no yield and one nothing
 * is known about all come out as null rather than as a paragraph saying so: this
 * is a footnote on a page about breaking and prices, and a caveat about a number
 * that is not shown takes more room than the number would have. The reasoning
 * lives in src/lib/recycle.ts, where it is read by whoever changes it.
 */
export function RecycleYieldPanel({ yield: y }: { yield: RecycleYield | null }) {
  if (y === null || y.kind !== "amount" || y.base === 0) return null;

  const fmt = y.perUnit < 0.1 ? precise : nuggets;
  const shown = y.perUnitCrafted ?? y.perUnit;

  return (
    <p className="text-body tracking-body text-deep-fern mt-32">
      Recycles for <span className="tabular-nums">{fmt.format(shown)}</span> nuggets per
      unit
      {y.perUnitCrafted !== null && (
        <>
          , <span className="tabular-nums">{fmt.format(y.perUnit)}</span> without the
          craft bonus
        </>
      )}
      .
    </p>
  );
}
