import Link from "next/link";
import { ItemSearch } from "@/app/search";
import { SettingsButton } from "@/app/drawer";
import { mode } from "@/lib/verdict";
import { worthList, type WorthRow } from "@/lib/worth";

// Prices move while you play; nothing here may be prerendered.
export const dynamic = "force-dynamic";

const kamas = new Intl.NumberFormat("fr-FR");

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
  const [{ rows, thresholdPercent, automatic }, currentMode] = await Promise.all([
    worthList(),
    mode(),
  ]);
  const worth = rows.filter((r) => r.status === "worth");
  const skip = rows.filter((r) => r.status === "skip");

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <div className="flex flex-wrap items-center justify-between gap-16">
        <p className="text-caption tracking-caption text-moss-70 uppercase">
          worth breaking
        </p>
        <div className="flex items-center gap-16">
          <SettingsButton mode={currentMode} thresholdPercent={thresholdPercent} />
          <ItemSearch />
        </div>
      </div>
      <h1 className="text-heading-lg tracking-heading-lg mt-12">
        {worth.length} item{worth.length === 1 ? "" : "s"} worth breaking
      </h1>
      <p className="text-body tracking-body text-sage-40 mt-12 max-w-[70ch]">
        {automatic
          ? `Runes worth more than ${pct(thresholdPercent)} over what a copy costs, taking the better of focusing and not.`
          : "Verdicts are set by hand — the threshold is off."}{" "}
        Estimated for an <span className="text-phosphor-white">average copy</span>, so an
        item&apos;s own page may differ when it is describing the one you hold.{" "}
        <Link href="/" className="text-lime-pulse">
          back to the breaker
        </Link>
      </p>

      {worth.length === 0 ? (
        <p className="border-circuit-border text-body tracking-body text-sage-40 mt-32 rounded-xl border px-24 py-20">
          {automatic ? (
            <>
              Nothing clears the bar yet. An item needs a price for a copy and a price for
              every rune it yields — browse a few in the HDV with the sniffer running, or
              lower the threshold in <span className="text-phosphor-white">settings</span>
              .
            </>
          ) : (
            <>
              <span className="text-phosphor-white">Verdicts are set to Manual</span>, so
              no item is judged for you and this list only ever holds what you mark by
              hand. Switch to Automatic in{" "}
              <span className="text-phosphor-white">settings</span> to rank every item the
              data can price.
            </>
          )}
        </p>
      ) : (
        <Table rows={worth} />
      )}

      {skip.length > 0 && (
        <>
          <h2 className="text-heading-sm tracking-heading-sm mt-48">
            Not worth breaking
          </h2>
          <p className="text-body-sm tracking-body-sm text-sage-40 mt-4">
            Judged and rejected, best first — the ones nearest the bar are the ones a
            price move would flip.
          </p>
          <Table rows={skip} />
        </>
      )}
    </main>
  );
}

function Table({ rows }: { rows: WorthRow[] }) {
  return (
    <div className="border-circuit-border mt-16 overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[760px] border-collapse text-left">
        <thead>
          <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
            <th className="py-12 pr-16 pl-20 font-medium">item</th>
            <th className="py-12 pr-16 font-medium">focus</th>
            <th className="py-12 pr-16 text-right font-medium">runes worth</th>
            <th className="py-12 pr-16 text-right font-medium">a copy costs</th>
            <th className="py-12 pr-16 text-right font-medium">profit</th>
            <th className="py-12 pr-20 text-right font-medium">coefficient</th>
          </tr>
        </thead>
        <tbody className="text-body-sm tracking-body-sm">
          {rows.map((r) => (
            <tr
              key={r.itemId}
              className="border-phosphor-blue-black border-b last:border-0"
            >
              <td className="py-12 pr-16 pl-20">
                <Link
                  href={`/item/${r.itemId}`}
                  className="text-phosphor-white hover:text-lime-pulse"
                >
                  {r.name}
                </Link>
                <span className="text-deep-fern text-caption block">
                  {r.type ?? "—"}
                  {r.level !== null && ` · level ${r.level}`}
                  {r.manual && <span className="text-moss-70"> · marked by you</span>}
                </span>
              </td>
              <td className="text-moss-80 py-12 pr-16">{r.focus ?? "no focus"}</td>
              <td className="text-moss-80 py-12 pr-16 text-right tabular-nums">
                {kamas.format(Math.round(r.value))} k
              </td>
              <td className="text-sage-40 py-12 pr-16 text-right tabular-nums">
                {kamas.format(Math.round(r.cost))} k
              </td>
              <td
                className={`py-12 pr-16 text-right tabular-nums ${
                  r.profit >= 0 ? "text-lime-pulse" : "text-sage-40"
                }`}
              >
                {pct(r.profit)}
              </td>
              <td className="text-deep-fern py-12 pr-20 text-right tabular-nums">
                {r.coefficient.toLocaleString("fr-FR", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
                %{!r.observed && <span title="No crush observed — assumed"> ?</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
