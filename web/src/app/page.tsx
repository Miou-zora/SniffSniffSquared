import Link from "next/link";

import { Live } from "@/app/live";
import { Projection } from "@/app/projection";
import { ItemSearch } from "@/app/search";
import { LocalTime } from "@/app/local-time";
import { VerdictBadge } from "@/app/verdict-badge";
import { loadBreaker, type BreakerView } from "@/lib/breaker";
import { verdictFor, type Verdict } from "@/lib/verdict";

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
  return <ItemView view={view} verdict={await verdictFor(view)} />;
}

/**
 * The whole page for one item, shared by the breaker and by /item/[id].
 *
 * They differ only in how the item was chosen — what is worth knowing about it
 * is the same either way, and duplicating this is how the two would drift.
 */
export function ItemView({ view, verdict }: { view: BreakerView; verdict: Verdict }) {
  const best = view.outcomes[0];
  const priced = best !== undefined && best.unitPrice !== null;

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <Header view={view} verdict={verdict} />
      {view.weighted.length === 0 ? (
        <NoStats view={view} />
      ) : (
        <div className="mt-40 grid items-start gap-24 md:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] xl:gap-40 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <div>
            <BestRune view={view} priced={priced} />
            <StatLines view={view} />
          </div>
          <Projection model={view.projection} itemName={view.item.name} />
        </div>
      )}
    </main>
  );
}

function Empty() {
  return (
    <main className="mx-auto w-full max-w-[1280px] px-24 py-96">
      <div className="flex items-center justify-between gap-16">
        <p className="text-caption tracking-caption text-moss-70 uppercase">breaker</p>
        <Live />
      </div>
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

function Header({ view, verdict }: { view: BreakerView; verdict: Verdict }) {
  const browsing = view.placedAt === null;
  return (
    <header>
      <div className="flex flex-wrap items-center justify-between gap-16">
        <p className="text-caption tracking-caption text-moss-70 uppercase">
          {browsing ? "browsing an item" : "in the breaker"}
        </p>
        <div className="flex items-center gap-16">
          <Link
            href="/worth"
            className="text-caption tracking-caption text-fern-link hover:text-lime-pulse uppercase"
          >
            worth breaking
          </Link>
          <ItemSearch />
          <Live />
        </div>
      </div>
      <div className="mt-12 flex flex-wrap items-center gap-x-16 gap-y-8">
        <h1 className="text-heading-lg tracking-heading-lg">{view.item.name}</h1>
        <VerdictBadge itemId={view.item.itemId} verdict={verdict} />
      </div>
      <p className="text-body tracking-body text-sage-40 mt-12">
        {view.item.type ?? "—"} · level {view.item.level}
        {view.placedAt !== null && (
          <>
            {" · placed "}
            <LocalTime iso={view.placedAt.toISOString()} />
          </>
        )}
        {view.uid !== null && (
          <span className="text-deep-fern">
            {" "}
            · {browsing ? "last instance seen" : "instance"} {view.uid}
          </span>
        )}
      </p>
      {browsing && (
        <p className="text-body-sm tracking-body-sm mt-8">
          <Link href="/" className="text-lime-pulse">
            back to the breaker
          </Link>
        </p>
      )}
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

/**
 * What to actually do with the item, which is not always "focus something".
 *
 * Focusing concentrates the item into one rune; crushing plain yields every
 * rune it carries. The sum of those often wins, so a card that only ever names
 * a rune is answering a question nobody asked — the choice includes not
 * focusing at all.
 *
 * Decided in kamas whenever both sides are priced. Rune counts cannot settle
 * it: one pile of 30 against six piles totalling 40 says nothing until each is
 * multiplied by what that rune sells for.
 */
function BestRune({ view, priced }: { view: BreakerView; priced: boolean }) {
  const best = view.outcomes[0];
  // Column 1 is the current coefficient — column 0 is the 100% ceiling.
  const runesNow = best.runes[1];
  const valueNow = best.value[1];
  const noneRunes = view.noFocus.runes[1];
  const noneValue = view.noFocus.value[1];

  const comparable = valueNow !== null && noneValue !== null;
  const focusWins = comparable ? valueNow >= noneValue : true;
  const high = comparable ? Math.max(valueNow, noneValue) : 0;
  const low = comparable ? Math.min(valueNow, noneValue) : 0;
  const edge = low > 0 ? (high / low - 1) * 100 : null;

  return (
    <section className="border-circuit-border bg-ground-iron rounded-2xl border p-32">
      <p className="text-caption tracking-caption text-moss-70 uppercase">
        {focusWins ? "best rune to focus" : "best move"}
      </p>
      <div className="mt-12 flex flex-wrap items-baseline gap-x-16 gap-y-8">
        <span className="text-lime-pulse font-goga text-heading tracking-heading">
          {focusWins ? best.rune : "no focus"}
        </span>
        <span className="text-subheading tracking-subheading text-phosphor-white">
          {n(focusWins ? runesNow : noneRunes, 1)} runes
        </span>
        {(focusWins ? valueNow : noneValue) !== null && (
          <span className="text-subheading tracking-subheading text-moss-80">
            {kamas.format(Math.round((focusWins ? valueNow : noneValue) ?? 0))} k
          </span>
        )}
      </div>
      {comparable && edge !== null && (
        <p className="text-body-sm tracking-body-sm text-moss-80 mt-12">
          {focusWins ? (
            <>
              Worth {n(edge, 0)}% more than crushing it with no focus, which yields{" "}
              {n(noneRunes, 1)} runes across every line for{" "}
              {kamas.format(Math.round(noneValue ?? 0))} k.
            </>
          ) : (
            <>
              Worth {n(edge, 0)}% more than focusing {best.rune}, the best single rune,
              which would give {n(runesNow, 1)} for{" "}
              {kamas.format(Math.round(valueNow ?? 0))} k.
            </>
          )}
        </p>
      )}
      <p className="text-body-sm tracking-body-sm text-sage-40 mt-16 max-w-[70ch]">
        {priced
          ? "Compared on what the runes sell for at the current coefficient."
          : "Ranked by rune count — no market price has been captured for these runes yet, so focusing and not focusing cannot be compared, and this assumes focusing. Browse runes in the HDV with the sniffer running to settle it."}{" "}
        Focus weight {n(best.focusWeight)} of {n(view.totalWeight)} total, at{" "}
        {n(view.coefficient, 3)}%
        {view.coefficientIsAssumed && " (assumed — no crush of this item observed yet)"}.
      </p>
    </section>
  );
}

function StatLines({ view }: { view: BreakerView }) {
  const hasAverages = view.averages.size > 0;

  return (
    <section className="mt-40">
      <h2 className="text-heading-sm tracking-heading-sm">Stat lines</h2>
      <p className="text-body-sm tracking-body-sm text-sage-40 mt-4">
        What this copy rolled, against what the item averages.
      </p>

      {!hasAverages && (
        <p className="border-circuit-border text-body-sm tracking-body-sm text-sage-40 mt-16 rounded-xl border px-16 py-12">
          <span className="text-phosphor-white">No average data for this item.</span> The
          ranges come from DofusDB and are stored per item type. Run{" "}
          <code className="text-moss-80">tools/import_items.py</code> from the repo root
          to fetch them — it resolves every id the database has seen, so one run covers
          this item and anything else new.
        </p>
      )}

      <div className="mt-16 overflow-x-auto">
        <table className="w-full min-w-[360px] border-collapse text-left">
          <thead>
            <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
              <th className="py-8 pr-16 font-medium">rune</th>
              <th className="py-8 pr-16 text-right font-medium">this copy</th>
              <th className="py-8 pr-16 text-right font-medium">average</th>
              <th className="py-8 pr-16 text-right font-medium">weight</th>
              <th className="py-8 text-right font-medium">share</th>
            </tr>
          </thead>
          <tbody className="text-body-sm tracking-body-sm">
            {view.weighted.map((l) => {
              const avg = view.averages.get(l.effectId);
              return (
                <tr key={l.effectId} className="border-phosphor-blue-black border-b">
                  <td className="text-phosphor-white py-12 pr-16">{l.rune}</td>
                  <td className="py-12 pr-16 text-right tabular-nums">{l.value}</td>
                  <td className="py-12 pr-16 text-right tabular-nums">
                    {avg ? (
                      <>
                        <span className="text-sage-60">{n(avg.avg, 1)}</span>
                        <span className="text-deep-fern text-caption block">
                          {avg.min}–{avg.max}
                        </span>
                      </>
                    ) : (
                      <span className="text-deep-fern">—</span>
                    )}
                  </td>
                  <td className="text-moss-80 py-12 pr-16 text-right tabular-nums">
                    {n(l.weight)}
                  </td>
                  <td className="text-sage-40 py-12 text-right tabular-nums">
                    {n((100 * l.weight) / view.totalWeight, 1)}%
                  </td>
                </tr>
              );
            })}
            <tr className="text-body-sm tracking-body-sm">
              <td className="text-deep-fern py-12 pr-16 uppercase">total</td>
              <td colSpan={2} className="text-deep-fern py-12 pr-16 text-right">
                {view.averageTotalWeight !== null && (
                  <>avg weight {n(view.averageTotalWeight)}</>
                )}
              </td>
              <td className="text-phosphor-white py-12 pr-16 text-right tabular-nums">
                {n(view.totalWeight)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      {view.averageTotalWeight !== null && (
        <p className="text-body-sm tracking-body-sm text-sage-40 mt-12">
          This copy is{" "}
          <span className="text-phosphor-white">
            {n((100 * view.totalWeight) / view.averageTotalWeight, 0)}%
          </span>{" "}
          of an average one. Rolls outside the template range are normal — items can be
          crafted and reforged by players.
        </p>
      )}

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
