import Image from "next/image";
import Link from "next/link";

import { AddToBasket, BulkAdd, ClearBasket, Quantity } from "@/app/craft/controls";
import { Live } from "@/app/live";
import {
  craftJobs,
  loadBasket,
  type BasketEntry,
  type PileNeed,
  type PileRow,
} from "@/lib/basket";
import { iconUrl } from "@/lib/icon";
import { describePlan } from "@/lib/craft";

// Prices move while you play, and the basket is written from the browser.
export const dynamic = "force-dynamic";

const kamas = new Intl.NumberFormat("fr-FR");

function k(v: number) {
  return `${kamas.format(Math.round(v))} k`;
}

/**
 * One shopping list for several crafts.
 *
 * Everything you mean to make on the left, the resources it adds up to on the
 * right. Two items that both want Ébonite show one line of four, priced as one
 * purchase — which is the whole reason this page is not just the craft estimate
 * on an item's page, read twice.
 */
export default async function CraftPage() {
  const [view, jobs] = await Promise.all([loadBasket(), craftJobs()]);
  const have = Object.fromEntries(view.entries.map((e) => [e.itemId, e.quantity]));
  const saved = view.separate - view.pooled;

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <div className="flex flex-wrap items-center justify-between gap-16">
        <p className="text-caption tracking-caption text-moss-70 uppercase">
          craft basket
        </p>
        <div className="flex flex-wrap items-center justify-end gap-16">
          <Link
            href="/"
            className="text-caption tracking-caption text-fern-link hover:text-lime-pulse uppercase"
          >
            breaker
          </Link>
          <Link
            href="/worth"
            className="text-caption tracking-caption text-fern-link hover:text-lime-pulse uppercase"
          >
            worth breaking
          </Link>
          <AddToBasket have={have} />
          <Live />
        </div>
      </div>

      <h1 className="text-heading-lg tracking-heading-lg mt-12">
        {view.entries.length === 0
          ? "Nothing to craft yet"
          : view.cost === null
            ? `${view.pile.length} resource${view.pile.length === 1 ? "" : "s"} to buy`
            : `${k(view.cost)} of resources`}
      </h1>

      <div className="mt-24">
        <BulkAdd jobs={jobs} />
      </div>

      {view.entries.length === 0 ? (
        <Empty />
      ) : (
        <>
          <p className="text-body tracking-body text-sage-40 mt-12 max-w-[74ch]">
            Quantities are added up across the whole basket before they are priced, so a
            resource two crafts share is bought once, off the batch ladder that fits the
            total.
            {view.unpriced > 0 && (
              <>
                {" "}
                <span className="text-phosphor-white">
                  {view.unpriced} resource{view.unpriced === 1 ? " has" : "s have"} no
                  captured price
                </span>{" "}
                — browse them in the HDV with the sniffer running and the total completes
                itself.
              </>
            )}
            {saved > 0 && (
              <>
                {" "}
                Buying for each craft separately would cost{" "}
                <span className="text-lime-pulse">{k(saved)}</span> more.
              </>
            )}
          </p>

          <div className="mt-40 grid items-start gap-24 md:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] xl:gap-40 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            <Crafts entries={view.entries} />
            <Pile rows={view.pile} total={view.cost} />
          </div>
        </>
      )}
    </main>
  );
}

function Empty() {
  return (
    <p className="border-circuit-border text-body tracking-body text-sage-40 mt-32 max-w-[74ch] rounded-xl border px-24 py-20">
      Search an item above to add it. Add as many as you like — their recipes are pooled
      into one list of resources to buy, so a single trip to the HDV covers the lot.
    </p>
  );
}

/**
 * The item's own icon, which is what you are actually scanning for in the HDV.
 *
 * `alt=""`: the name is right next to it, and a screen reader reading the same
 * word twice is worse than not reading the picture at all. An item DofusDB has
 * no icon for keeps the same square of space, so the column stays a column.
 *
 * `unoptimized` because these are already 13-20 KB PNGs shown at 32 px: running
 * them through the optimizer would add a server round trip, and a sharp
 * dependency to the standalone image, to save nothing.
 */
function Icon({ iconId, size = 32 }: { iconId: number | null; size?: number }) {
  if (iconId === null) {
    return (
      <span
        aria-hidden
        className="border-circuit-border block shrink-0 rounded-lg border"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <Image
      src={iconUrl(iconId)}
      alt=""
      width={size}
      height={size}
      className="shrink-0"
      unoptimized
    />
  );
}

function Crafts({ entries }: { entries: BasketEntry[] }) {
  return (
    <section className="border-circuit-border rounded-2xl border">
      <div className="border-phosphor-blue-black flex items-center justify-between gap-16 border-b px-20 py-16">
        <h2 className="text-caption tracking-caption text-deep-fern uppercase">
          crafting
        </h2>
        <ClearBasket />
      </div>
      <ul>
        {entries.map((e) => (
          <li
            key={e.itemId}
            className="border-phosphor-blue-black border-b px-20 py-16 last:border-0"
          >
            <div className="flex items-start justify-between gap-16">
              <div className="flex min-w-0 items-center gap-12">
                <Icon iconId={e.iconId} />
                <div className="min-w-0">
                  <Link
                    href={`/item/${e.itemId}`}
                    className="text-body-sm tracking-body-sm text-phosphor-white hover:text-lime-pulse block"
                  >
                    {e.name}
                  </Link>
                  <span className="text-caption text-deep-fern block">
                    {e.ingredients === null ? (
                      <span className="text-sage-40">no recipe</span>
                    ) : (
                      <>
                        {e.ingredients.length} ingredient
                        {e.ingredients.length === 1 ? "" : "s"}
                        {e.cost !== null && ` · ${k(e.cost)} on its own`}
                      </>
                    )}
                  </span>
                </div>
              </div>
              <Quantity itemId={e.itemId} quantity={e.quantity} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Which crafts want this resource, and how much each takes.
 *
 * Cut to the three biggest with a count for the rest: a whole job's level band
 * puts thirty crafts on one line of Ébonite, and thirty names is not a reason,
 * it is a wall. The full list stays in the title for when it is.
 */
function NeedBy({ needBy }: { needBy: PileNeed[] }) {
  const ordered = [...needBy].sort((a, b) => b.quantity - a.quantity);
  const shown = ordered.slice(0, 3);
  const rest = ordered.length - shown.length;
  return (
    <span
      className="text-caption text-deep-fern block"
      title={ordered.map((n) => `${n.quantity} × ${n.name}`).join("\n")}
    >
      {shown.map((n) => `${n.quantity} × ${n.name}`).join(" · ")}
      {rest > 0 && ` · +${rest} more`}
    </span>
  );
}

function Pile({ rows, total }: { rows: PileRow[]; total: number | null }) {
  if (rows.length === 0) {
    return (
      <p className="border-circuit-border text-body tracking-body text-sage-40 rounded-2xl border px-24 py-20">
        Nothing in the basket has a recipe, so there is nothing to buy. Recipes come from
        DofusDB; an item that cannot be crafted simply has none.
      </p>
    );
  }

  return (
    <div className="border-circuit-border overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
            <th className="py-12 pr-16 pl-20 font-medium">resource</th>
            <th className="py-12 pr-16 text-right font-medium">need</th>
            <th className="py-12 pr-16 font-medium">buy</th>
            <th className="py-12 pr-20 text-right font-medium">cost</th>
          </tr>
        </thead>
        <tbody className="text-body-sm tracking-body-sm">
          {rows.map((r) => (
            <tr
              key={r.itemId}
              className="border-phosphor-blue-black border-b last:border-0"
            >
              <td className="py-12 pr-16 pl-20">
                <div className="flex items-center gap-12">
                  <Icon iconId={r.iconId} />
                  <div className="min-w-0">
                    <span className="text-phosphor-white">{r.name}</span>
                    {r.needBy.length > 1 && <NeedBy needBy={r.needBy} />}
                  </div>
                </div>
              </td>
              <td className="text-moss-80 py-12 pr-16 text-right tabular-nums">
                {kamas.format(r.quantity)}
              </td>
              <td
                className="text-sage-40 py-12 pr-16 tabular-nums"
                title={
                  r.plan === null
                    ? "No price captured for this resource"
                    : r.plan.rule === "cheapest"
                      ? "One batch size for the lot — mixing would cost more per unit"
                      : undefined
                }
              >
                {r.plan === null ? (
                  <span className="text-deep-fern">no price</span>
                ) : (
                  <>
                    {describePlan(r.plan)}
                    {r.overbuy > 0 && (
                      <span className="text-deep-fern"> · {r.overbuy} spare</span>
                    )}
                  </>
                )}
              </td>
              <td className="text-sage-40 py-12 pr-20 text-right tabular-nums">
                {r.cost === null ? "—" : k(r.cost)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-phosphor-blue-black text-body-sm tracking-body-sm border-t">
            <td className="text-caption tracking-caption text-deep-fern py-12 pr-16 pl-20 uppercase">
              total
            </td>
            <td />
            <td />
            <td className="text-phosphor-white py-12 pr-20 text-right tabular-nums">
              {total === null ? "incomplete" : k(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
