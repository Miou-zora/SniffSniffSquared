import { LocalTime } from "@/app/local-time";
import { PriceChart } from "@/app/item/[id]/chart";
import type { HistoryView } from "@/lib/history";

const kamas = new Intl.NumberFormat("fr-FR");

/**
 * What this item has sold for, over time.
 *
 * Lives on the item's own page rather than a page of its own: a rune has no
 * projection to show and a price is the only thing worth knowing about it, so
 * splitting the two meant two pages for one item and neither of them complete.
 * Gear gets it under its projection, where "what does a copy cost" was already
 * a number on the page — now with the history behind it.
 */
export function PriceHistory({ view }: { view: HistoryView }) {
  const latest = view.ladder.at(-1) ?? null;
  const first = view.ladder.at(0) ?? null;
  const latestOffer = view.offers.at(-1) ?? null;
  // Measured on the x1 quote, which is the number the rest of the app uses.
  const drift =
    first !== null && latest !== null && first.b1 > 0 && latest.b1 > 0
      ? (latest.b1 / first.b1 - 1) * 100
      : null;
  const captures = view.ladder.length + view.offers.length;

  if (captures === 0) {
    return (
      <p className="border-circuit-border text-body tracking-body text-sage-40 mt-16 max-w-[74ch] rounded-xl border px-24 py-20">
        No price captured for this item yet. The sniffer sees one when you browse it in
        the HDV — open its category with capture running and this fills in.
      </p>
    );
  }

  return (
    <>
      <div className="mt-16 flex flex-wrap gap-16">
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
        <Tile
          label="last seen"
          value={<LocalTime iso={(latest ?? latestOffer)!.at} withDate />}
          note={`${captures} capture${captures === 1 ? "" : "s"} on record`}
        />
      </div>

      <PriceChart ladder={view.ladder} offers={view.offers} />

      {view.ladder.length > 0 && (
        <div className="border-circuit-border mt-24 overflow-x-auto rounded-2xl border">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <caption className="text-caption tracking-caption text-deep-fern px-20 py-12 text-left uppercase">
              every capture · the chart plots x1; a dash is a size nobody had on sale
            </caption>
            <thead>
              <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-y uppercase">
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
      )}
    </>
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
