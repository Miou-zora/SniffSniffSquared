import Link from "next/link";
import { ItemSearch } from "@/app/search";
import { Live } from "@/app/live";
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
  const { rows } = await worthList();
  const worth = rows.filter((r) => r.status === "worth");
  const skip = rows.filter((r) => r.status === "skip");

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <div className="flex flex-wrap items-center justify-between gap-16">
        <p className="text-caption tracking-caption text-moss-70 uppercase">
          worth breaking
        </p>
        <div className="flex items-center gap-16">
          <ItemSearch />
          <Live />
        </div>
      </div>
      <h1 className="text-heading-lg tracking-heading-lg mt-12">
        {worth.length} item{worth.length === 1 ? "" : "s"} marked worth breaking
      </h1>
      <p className="text-body tracking-body text-sage-40 mt-12 max-w-[70ch]">
        The items you marked <span className="text-phosphor-white">Worth it</span>, with
        what they are worth today. Figures are estimated for an average copy and are
        context only — nothing joins or leaves this list except by your mark.{" "}
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
        <Table rows={worth} />
      )}

      {skip.length > 0 && (
        <>
          <h2 className="text-heading-sm tracking-heading-sm mt-48">Marked as skip</h2>
          <p className="text-body-sm tracking-body-sm text-sage-40 mt-4">
            Items you ruled out. Worth a glance when prices move.
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
            <th className="py-12 pr-16 text-right font-medium">to craft</th>
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
                {r.value === null ? "—" : `${kamas.format(Math.round(r.value))} k`}
              </td>
              <td className="text-sage-40 py-12 pr-16 text-right tabular-nums">
                {r.cost === null ? "—" : `${kamas.format(Math.round(r.cost))} k`}
              </td>
              <td
                className={`py-12 pr-16 text-right tabular-nums ${
                  r.craft !== null && r.cost !== null && r.craft < r.cost
                    ? "text-moss-80"
                    : "text-sage-40"
                }`}
                title={
                  r.craft === null
                    ? "No recipe, or an ingredient with no captured price"
                    : r.cost !== null && r.craft < r.cost
                      ? "Cheaper to make than to buy"
                      : undefined
                }
              >
                {r.craft === null ? "—" : `${kamas.format(Math.round(r.craft))} k`}
              </td>
              <td
                className={`py-12 pr-16 text-right tabular-nums ${
                  r.profit === null
                    ? "text-deep-fern"
                    : r.profit >= 0
                      ? "text-lime-pulse"
                      : "text-sage-40"
                }`}
                title={
                  r.profit === null
                    ? "No price captured for a copy, or for one of its runes"
                    : undefined
                }
              >
                {r.profit === null ? "no price" : pct(r.profit)}
              </td>
              <td
                className="text-deep-fern py-12 pr-20 text-right tabular-nums"
                title={r.observed ? undefined : "No crush of this item captured"}
              >
                {/* Nothing rather than an assumed 100%: the rate is per item and
                    goes above 100, so a placeholder printed like a reading is a
                    number people would plan around. */}
                {r.observed
                  ? `${r.coefficient.toLocaleString("fr-FR", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}%`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
