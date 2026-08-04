import Image from "next/image";
import { notFound } from "next/navigation";

import { PageHeader } from "@/app/header";
import { CraftBreakdown } from "@/app/item/[id]/craft";
import { PriceHistory } from "@/app/item/[id]/history";
import { RecycleYieldPanel } from "@/app/item/[id]/recycle";
import { ItemView } from "@/app/page";
import { loadItem } from "@/lib/breaker";
import { priceHistory } from "@/lib/history";
import { iconUrl } from "@/lib/icon";
import { isBreakableKind } from "@/lib/kind";
import { recycleYield } from "@/lib/recycle";
import { verdictFor } from "@/lib/verdict";

// Prices and crushes land while you play, so this is never prerendered — the
// same reason the breaker page is not.
export const dynamic = "force-dynamic";

/**
 * Any item, whether or not you hold one — and whatever kind it is.
 *
 * The breaker page answers "what is the thing in front of me worth"; this one
 * answers "what would that item be worth", which is the question you have
 * before buying one to break.
 *
 * Two shapes, because items come in two kinds. Something breakable leads with
 * its projection and carries its price history underneath. A rune or a resource
 * has no projection to lead with — the price *is* the subject — so the history
 * is the page. Both live at this address: one item, one page, whatever it turns
 * out to be.
 */
export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const itemId = Number.parseInt(id, 10);
  if (!Number.isInteger(itemId) || itemId <= 0) notFound();

  const [view, history, recycle] = await Promise.all([
    loadItem(itemId),
    priceHistory(itemId),
    recycleYield(itemId),
  ]);

  // Lines that map to runes, and a kind the crusher would actually take. Both
  // halves are needed: a rune is itself a stat line, so the first test alone
  // gave Rune Vi a projection of what it is worth to turn into runes.
  if (view !== null && view.weighted.length > 0 && isBreakableKind(view.item.type)) {
    return (
      <ItemView view={view} verdict={await verdictFor(view)}>
        <section className="mt-48">
          <h2 className="text-heading-sm tracking-heading-sm">What recycling pays</h2>
          <div className="mt-12">
            <RecycleYieldPanel yield={recycle} />
          </div>
        </section>
        {history !== null && (
          <section className="mt-48">
            <h2 className="text-heading-sm tracking-heading-sm">What a copy costs</h2>
            <PriceHistory view={history} />
          </section>
        )}
      </ItemView>
    );
  }

  if (history === null) notFound();

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <PageHeader current="/items" />

      <div className="mt-24 flex flex-wrap items-center gap-16">
        {history.item.iconId !== null && (
          <Image
            src={iconUrl(history.item.iconId)}
            alt=""
            width={40}
            height={40}
            unoptimized
          />
        )}
        <h1 className="text-heading-lg tracking-heading-lg">{history.item.name}</h1>
      </div>
      <p className="text-body tracking-body text-sage-40 mt-12 max-w-[74ch]">
        <span className="text-moss-70">price history</span> · {history.item.type ?? "—"}
        {history.item.level !== null && ` · level ${history.item.level}`}
      </p>

      <section className="mt-32">
        <h2 className="text-heading-sm tracking-heading-sm">What it costs to craft</h2>
        <div className="mt-12">
          <CraftBreakdown estimate={view?.projection.craft ?? null} />
        </div>
      </section>

      <section className="mt-32">
        <h2 className="text-heading-sm tracking-heading-sm">What recycling pays</h2>
        <div className="mt-12">
          <RecycleYieldPanel yield={recycle} />
        </div>
      </section>

      <section className="mt-32">
        <h2 className="text-heading-sm tracking-heading-sm">Price history</h2>
        <PriceHistory view={history} />
      </section>
    </main>
  );
}
