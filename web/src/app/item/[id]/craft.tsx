import { ItemPrice } from "@/app/item-price";
import { describePlan } from "@/lib/craft";
import type { CraftEstimate } from "@/lib/breaker";

const kamas = new Intl.NumberFormat("fr-FR");

/**
 * What this item costs to make, ingredient by ingredient — the same figures
 * the breaker page's cost readout uses, but standalone: a resource or
 * consommable has no projection to attach it to, so this is its own section
 * rather than a line inside one.
 */
export function CraftBreakdown({ estimate }: { estimate: CraftEstimate | null }) {
  if (estimate === null) {
    return (
      <p className="text-body tracking-body text-sage-40 max-w-[74ch]">
        No recipe for this item — most resources have none, and DofusDB was asked
        directly.
      </p>
    );
  }

  const via =
    estimate.source === "dofusdb" ? (
      <span
        className="text-deep-fern"
        title="Fetched from DofusDB — the importer has not seen this item yet"
      >
        {" "}
        · via DofusDB
      </span>
    ) : null;

  const unpriced = estimate.ingredients.filter((i) => i.plan === null);
  if (estimate.cost === null) {
    return (
      <p className="text-body tracking-body text-sage-40 max-w-[74ch]">
        <span className="text-phosphor-white">No captured price</span> for{" "}
        {unpriced.map((i, n) => (
          <span key={i.itemId}>
            {n > 0 && ", "}
            <ItemPrice name={i.name} ladder={i.ladder} itemId={i.itemId} />
          </span>
        ))}
        . Open this item&apos;s craft panel in game — the client prices every ingredient
        and the sniffer stores them.
        {via}
      </p>
    );
  }

  return (
    <p className="text-body tracking-body text-sage-40 max-w-[74ch]">
      <span className="text-phosphor-white tabular-nums">
        {kamas.format(estimate.cost)}
      </span>{" "}
      k for{" "}
      {estimate.ingredients.map((i, n) => (
        <span key={i.itemId}>
          {n > 0 && ", "}
          {i.quantity}x <ItemPrice name={i.name} ladder={i.ladder} itemId={i.itemId} />
          <span
            className="text-deep-fern"
            title={
              i.plan
                ? `${describePlan(i.plan)} = ${kamas.format(i.plan.cost)} k for ${i.plan.units} units, ${i.plan.rule === "mixed" ? "filled from the largest batch down" : "one batch size for the lot, it prices better"}`
                : undefined
            }
          >
            {" "}
            ({i.plan ? describePlan(i.plan) : "—"})
          </span>
        </span>
      ))}
      {via}
      <span className="text-deep-fern block">
        Hover an ingredient to see its full x1/x10/x100/x1000 ladder — the cheapest rate
        is marked.
      </span>
    </p>
  );
}
