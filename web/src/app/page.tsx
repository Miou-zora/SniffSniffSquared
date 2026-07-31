import { loadBreaker, type BreakerView } from "@/lib/breaker";
import { profitPercent } from "@/lib/brisage";

// The breaker's contents change while you play; nothing here may be prerendered.
export const dynamic = "force-dynamic";

const kamas = new Intl.NumberFormat("fr-FR");

function n(v: number, digits = 2) {
  return v.toLocaleString("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export default async function Home() {
  const view = await loadBreaker();
  if (!view) return <Empty />;

  const best = view.outcomes[0];
  const priced = best !== undefined && best.unitPrice !== null;

  return (
    <main className="mx-auto w-full max-w-[1280px] px-24 py-64">
      <Header view={view} />
      {view.weighted.length === 0 ? (
        <NoStats view={view} />
      ) : (
        <>
          <BestRune view={view} priced={priced} />
          <StatLines view={view} />
          <RuneTable view={view} />
          <ValueTable view={view} />
        </>
      )}
    </main>
  );
}

function Empty() {
  return (
    <main className="mx-auto w-full max-w-[1280px] px-24 py-96">
      <p className="text-caption tracking-caption text-moss-70 uppercase">breaker</p>
      <h1 className="text-heading-lg tracking-heading-lg mt-16">
        Nothing in the breaker
      </h1>
      <p className="text-body tracking-body text-sage-40 mt-20 max-w-[56ch]">
        Put an item into the breaker while the sniffer is capturing and this page will
        show what it is worth to crush, and which rune is best to focus.
      </p>
    </main>
  );
}

function Header({ view }: { view: BreakerView }) {
  return (
    <header>
      <p className="text-caption tracking-caption text-moss-70 uppercase">
        in the breaker
      </p>
      <h1 className="text-heading-lg tracking-heading-lg mt-12">{view.item.name}</h1>
      <p className="text-body tracking-body text-sage-40 mt-12">
        {view.item.type ?? "—"} · level {view.item.level} · placed{" "}
        {view.placedAt.toLocaleTimeString("fr-FR")}
        {view.uid !== null && (
          <span className="text-deep-fern"> · instance {view.uid}</span>
        )}
      </p>
    </header>
  );
}

function NoStats({ view }: { view: BreakerView }) {
  return (
    <p className="border-circuit-border text-body tracking-body text-sage-40 mt-32 rounded-xl border px-24 py-20">
      No stat lines were captured for this instance
      {view.uid === null
        ? " — the placement predates instance tracking, so its stats cannot be matched."
        : "."}{" "}
      The item detail arrives with the placement, so re-placing the item will fill this
      in.
    </p>
  );
}

function BestRune({ view, priced }: { view: BreakerView; priced: boolean }) {
  const best = view.outcomes[0];
  // Column 1 is the current coefficient — column 0 is the 100% ceiling.
  const runesNow = best.runes[1];
  const valueNow = best.value[1];

  return (
    <section className="border-circuit-border bg-ground-iron mt-40 rounded-2xl border p-32">
      <p className="text-caption tracking-caption text-moss-70 uppercase">
        best rune to focus
      </p>
      <div className="mt-12 flex flex-wrap items-baseline gap-x-16 gap-y-8">
        <span className="text-lime-pulse font-goga text-heading tracking-heading">
          {best.rune}
        </span>
        <span className="text-subheading tracking-subheading text-phosphor-white">
          {n(runesNow, 1)} runes
        </span>
        {valueNow !== null && (
          <span className="text-subheading tracking-subheading text-moss-80">
            {kamas.format(Math.round(valueNow))} k
          </span>
        )}
      </div>
      <p className="text-body-sm tracking-body-sm text-sage-40 mt-16 max-w-[70ch]">
        {priced
          ? "Ranked by what the runes sell for at the current coefficient."
          : "Ranked by rune count — no market price has been captured for these runes yet, so kamas cannot be compared. Browse runes in the HDV with the sniffer running to fill the prices in."}{" "}
        Focus weight {n(best.focusWeight)} of {n(view.totalWeight)} total, at{" "}
        {n(view.coefficient, 3)}%
        {view.coefficientIsAssumed && " (assumed — no crush observed yet)"}.
      </p>
    </section>
  );
}

function StatLines({ view }: { view: BreakerView }) {
  return (
    <section className="mt-48">
      <h2 className="text-heading-sm tracking-heading-sm">Stat lines</h2>
      <div className="mt-16 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead>
            <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
              <th className="py-8 pr-16 font-medium">rune</th>
              <th className="py-8 pr-16 font-medium">value</th>
              <th className="py-8 pr-16 text-right font-medium">rune weight</th>
              <th className="py-8 pr-16 text-right font-medium">line weight</th>
              <th className="py-8 text-right font-medium">share</th>
            </tr>
          </thead>
          <tbody className="text-body-sm tracking-body-sm">
            {view.weighted.map((l) => (
              <tr key={l.effectId} className="border-phosphor-blue-black border-b">
                <td className="text-phosphor-white py-10 pr-16">{l.rune}</td>
                <td className="py-10 pr-16">{l.value}</td>
                <td className="py-10 pr-16 text-right">{l.runeWeight}</td>
                <td className="text-moss-80 py-10 pr-16 text-right">{n(l.weight)}</td>
                <td className="text-sage-40 py-10 text-right">
                  {n((100 * l.weight) / view.totalWeight, 1)}%
                </td>
              </tr>
            ))}
            <tr className="text-body-sm tracking-body-sm">
              <td className="text-deep-fern py-10 pr-16 uppercase">total</td>
              <td colSpan={2} />
              <td className="text-phosphor-white py-10 pr-16 text-right">
                {n(view.totalWeight)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      {view.unmapped.length > 0 && (
        <p className="text-body-sm tracking-body-sm text-sage-40 mt-12">
          Not counted, because they yield no rune:{" "}
          {view.unmapped.map((l) => `effect ${l.effectId} (${l.value})`).join(", ")}.
          Weapon damage lines and maluses both land here.
        </p>
      )}
    </section>
  );
}

function ColumnHead({ view }: { view: BreakerView }) {
  return (
    <thead>
      <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
        <th className="py-8 pr-16 font-medium">focus</th>
        {view.columns.map((c) => (
          <th key={c.label} className="py-8 pl-16 text-right font-medium">
            <span className="text-moss-70">{c.label}</span>
            <span className="text-deep-fern block normal-case">
              {n(c.coefficient, 2)}%
            </span>
          </th>
        ))}
      </tr>
    </thead>
  );
}

function RuneTable({ view }: { view: BreakerView }) {
  return (
    <section className="mt-48">
      <h2 className="text-heading-sm tracking-heading-sm">Runes obtained</h2>
      <p className="text-body-sm tracking-body-sm text-sage-40 mt-8 max-w-[76ch]">
        One row per focus choice, plus crushing with no focus. Columns project the
        coefficient forward as it decays: it drops with every rune produced, so a long
        crafting run is worth less per item than the first crush.
      </p>
      <div className="mt-16 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <ColumnHead view={view} />
          <tbody className="text-body-sm tracking-body-sm">
            {view.outcomes.map((o, i) => (
              <tr key={o.effectId} className="border-phosphor-blue-black border-b">
                <td
                  className={`py-10 pr-16 ${i === 0 ? "text-lime-pulse" : "text-phosphor-white"}`}
                >
                  {o.rune}
                </td>
                {o.runes.map((r, j) => (
                  <td key={j} className="py-10 pl-16 text-right tabular-nums">
                    {n(r, 1)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-phosphor-blue-black border-b">
              <td className="text-sage-40 py-10 pr-16">no focus</td>
              {view.noFocus.runes.map((r, j) => (
                <td key={j} className="text-sage-40 py-10 pl-16 text-right tabular-nums">
                  {n(r, 1)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ValueTable({ view }: { view: BreakerView }) {
  const anyPriced = view.outcomes.some((o) => o.unitPrice !== null);

  return (
    <section className="mt-48 pb-64">
      <h2 className="text-heading-sm tracking-heading-sm">Value</h2>
      <p className="text-body-sm tracking-body-sm text-sage-40 mt-8 max-w-[76ch]">
        {anyPriced ? (
          <>
            Kamas the runes are worth, at the latest captured market price.
            {view.itemCost !== null ? (
              <>
                {" "}
                The percentage is profit against what this item last sold for (
                {kamas.format(view.itemCost)} k).
              </>
            ) : (
              <> No price captured for the item itself, so profit cannot be shown.</>
            )}
          </>
        ) : (
          <>
            No market price has been captured for any of these runes, so there is nothing
            to value them at. Browse the runes in the HDV with the sniffer running and
            this table fills in.
          </>
        )}
      </p>

      {anyPriced && (
        <div className="mt-16 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <ColumnHead view={view} />
            <tbody className="text-body-sm tracking-body-sm">
              {view.outcomes.map((o, i) => (
                <tr key={o.effectId} className="border-phosphor-blue-black border-b">
                  <td
                    className={`py-10 pr-16 ${i === 0 ? "text-lime-pulse" : "text-phosphor-white"}`}
                  >
                    {o.rune}
                    {o.unitPrice === null && (
                      <span className="text-deep-fern"> · no price</span>
                    )}
                  </td>
                  {o.value.map((v, j) => (
                    <Cell key={j} value={v} cost={view.itemCost} />
                  ))}
                </tr>
              ))}
              <tr className="border-phosphor-blue-black border-b">
                <td className="text-sage-40 py-10 pr-16">no focus</td>
                {view.noFocus.value.map((v, j) => (
                  <Cell key={j} value={v} cost={view.itemCost} muted />
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {anyPriced && view.unpricedRunes.length > 0 && (
        <p className="text-body-sm tracking-body-sm text-sage-40 mt-12">
          No captured price for: {view.unpricedRunes.join(", ")}. Those rows are blank
          rather than zero — an unknown price is not a price of nothing.
        </p>
      )}
    </section>
  );
}

function Cell({
  value,
  cost,
  muted = false,
}: {
  value: number | null;
  cost: number | null;
  muted?: boolean;
}) {
  if (value === null) {
    return <td className="text-deep-fern py-10 pl-16 text-right">—</td>;
  }
  const profit = cost === null ? null : profitPercent(value, cost);
  return (
    <td className="py-10 pl-16 text-right tabular-nums">
      <span className={muted ? "text-sage-40" : "text-moss-80"}>
        {kamas.format(Math.round(value))}
      </span>
      {profit !== null && (
        <span
          className={`block ${profit >= 0 ? "text-lime-pulse" : "text-sage-40"} text-caption tracking-caption`}
        >
          {profit >= 0 ? "+" : ""}
          {n(profit, 0)}%
        </span>
      )}
    </td>
  );
}
