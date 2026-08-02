import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/app/header";
import { LocalTime } from "@/app/local-time";
import { PriceChart } from "@/app/price/[id]/chart";
import { priceHistory } from "@/lib/history";
import { iconUrl } from "@/lib/icon";

// Prices arrive while you browse; nothing here may be prerendered.
export const dynamic = "force-dynamic";

const kamas = new Intl.NumberFormat("fr-FR");

/**
 * What one item has sold for, over time.
 *
 * `prices` was always a time series and every other page read only its last
 * row. A rune's x1 price is the multiplier under every rune figure in this app,
 * so whether it has been drifting is worth seeing rather than assuming.
 */
export default async function PricePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const itemId = Number(id);
  if (!Number.isInteger(itemId) || itemId <= 0) notFound();

  const view = await priceHistory(itemId);
  if (view === null) notFound();

  const latest = view.ladder.at(-1) ?? null;
  const first = view.ladder.at(0) ?? null;
  const latestOffer = view.offers.at(-1) ?? null;
  // Measured on the x1 quote, which is the number the rest of the app uses.
  const drift =
    first !== null && latest !== null && first.b1 > 0 && latest.b1 > 0
      ? (latest.b1 / first.b1 - 1) * 100
      : null;

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <PageHeader current="/items" />

      <div className="mt-24 flex flex-wrap items-center gap-16">
        {view.item.iconId !== null && (
          <Image
            src={iconUrl(view.item.iconId)}
            alt=""
            width={40}
            height={40}
            unoptimized
          />
        )}
        <h1 className="text-heading-lg tracking-heading-lg">{view.item.name}</h1>
      </div>
      <p className="text-body tracking-body text-sage-40 mt-12">
        <span className="text-moss-70">price history</span> · {view.item.type ?? "—"}
        {view.item.level !== null && ` · level ${view.item.level}`} ·{" "}
        {view.ladder.length + view.offers.length} observation
        {view.ladder.length + view.offers.length === 1 ? "" : "s"} ·{" "}
        <Link href={`/item/${view.item.itemId}`} className="text-lime-pulse">
          what it is worth to break
        </Link>
      </p>

      <div className="mt-32 flex flex-wrap gap-16">
        {latest !== null && (
          <Tile
            label="x1 now"
            value={latest.b1 > 0 ? `${kamas.format(latest.b1)} k` : "none on sale"}
            note={
              drift === null
                ? "no earlier quote to compare"
                : `${drift >= 0 ? "+" : ""}${drift.toFixed(0)}% since the first capture`
            }
          />
        )}
        {latestOffer !== null && (
          <Tile
            label="cheapest listing"
            value={`${kamas.format(latestOffer.cheapest)} k`}
            note={`${latestOffer.listings} on sale in that snapshot`}
          />
        )}
        {(latest ?? latestOffer) && (
          <Tile
            label="last seen"
            value={<LocalTime iso={(latest ?? latestOffer)!.at} withDate />}
            note="the sniffer sees a price only when you browse the item"
          />
        )}
      </div>

      <PriceChart ladder={view.ladder} offers={view.offers} />

      {view.ladder.length > 0 && (
        <>
          <h2 className="text-heading-sm tracking-heading-sm mt-48">Every capture</h2>
          <p className="text-body-sm tracking-body-sm text-sage-40 mt-4">
            The chart plots these per unit, so the four batch sizes share one axis. Here
            they are as quoted. A dash is a size nobody had on sale.
          </p>
          <div className="border-circuit-border mt-16 overflow-x-auto rounded-2xl border">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
                  <th className="py-12 pr-16 pl-20 font-medium">seen</th>
                  <th className="py-12 pr-16 text-right font-medium">x1</th>
                  <th className="py-12 pr-16 text-right font-medium">x10</th>
                  <th className="py-12 pr-16 text-right font-medium">x100</th>
                  <th className="py-12 pr-20 text-right font-medium">x1000</th>
                </tr>
              </thead>
              <tbody className="text-body-sm tracking-body-sm">
                {[...view.ladder].reverse().map((row) => (
                  <tr
                    key={row.at}
                    className="border-phosphor-blue-black border-b last:border-0"
                  >
                    <td className="text-sage-40 py-12 pr-16 pl-20">
                      <LocalTime iso={row.at} withDate />
                    </td>
                    {[row.b1, row.b10, row.b100, row.b1000].map((v, i) => (
                      <td
                        key={i}
                        className={`py-12 tabular-nums ${i === 3 ? "pr-20" : "pr-16"} text-right ${
                          v > 0 ? "text-moss-80" : "text-deep-fern"
                        }`}
                      >
                        {v > 0 ? kamas.format(v) : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note: string;
}) {
  return (
    <div className="border-circuit-border bg-ground-iron min-w-[14rem] rounded-2xl border px-24 py-20">
      <p className="text-caption tracking-caption text-deep-fern uppercase">{label}</p>
      <p className="text-subheading tracking-subheading text-phosphor-white mt-8 tabular-nums">
        {value}
      </p>
      <p className="text-caption tracking-caption text-sage-40 mt-8">{note}</p>
    </div>
  );
}
