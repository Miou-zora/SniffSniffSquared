import Link from "next/link";
import { PageHeader } from "@/app/header";
import { WorthTable } from "@/app/worth/table";
import { worthList } from "@/lib/worth";

// Prices move while you play; nothing here may be prerendered.
export const dynamic = "force-dynamic";

function pct(v: number) {
  return `${v >= 0 ? "+" : ""}${v.toLocaleString("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}%`;
}

/**
 * Every item worth breaking, ranked.
 *
 * Estimated for an average copy — see `worthList`. An item's own page can say
 * something different, because there it may be describing the specific copy you
 * are holding rather than the type.
 */
export default async function WorthPage() {
  const { rows, automatic, thresholdPercent } = await worthList();
  const worth = rows.filter((r) => r.status === "worth");
  const skip = rows.filter((r) => r.status === "skip");

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <PageHeader label="worth breaking" current="/worth" />
      <h1 className="text-heading-lg tracking-heading-lg mt-12">
        {worth.length} item{worth.length === 1 ? "" : "s"}{" "}
        {automatic ? "worth breaking" : "marked worth breaking"}
      </h1>
      <p className="text-body tracking-body text-sage-40 mt-12 max-w-[70ch]">
        {automatic ? (
          <>
            Anything whose runes fetch over{" "}
            <span className="text-phosphor-white">{pct(thresholdPercent)}</span> against
            the cheaper of buying and crafting it, plus whatever you marked yourself.
          </>
        ) : (
          <>
            The items you marked <span className="text-phosphor-white">Worth it</span> —
            verdicts are set to Manual, so nothing is judged for you.
          </>
        )}{" "}
        <Link href="/" className="text-lime-pulse">
          back to the breaker
        </Link>
      </p>

      {worth.length === 0 ? (
        <p className="border-circuit-border text-body tracking-body text-sage-40 mt-32 rounded-xl border px-24 py-20">
          Nothing marked yet. Open an item — from the search above, or the breaker — and
          mark it <span className="text-phosphor-white">Worth it</span> in its verdict
          panel. The automatic verdict on that panel is a suggestion; this list only holds
          what you decide.
        </p>
      ) : (
        <WorthTable rows={worth} />
      )}

      {skip.length > 0 && (
        <>
          <h2 className="text-heading-sm tracking-heading-sm mt-48">Marked as skip</h2>
          <p className="text-body-sm tracking-body-sm text-sage-40 mt-4">
            Items you ruled out by hand, kept because a price move can change your mind.
            Items the threshold declines are simply absent.
          </p>
          <WorthTable rows={skip} />
        </>
      )}
    </main>
  );
}
