import { PageHeader } from "@/app/header";
import { ItemsTable } from "@/app/items/table";
import { catalogueList } from "@/lib/catalogue";

// A crush or a price while you play changes this page; nothing may be prerendered.
export const dynamic = "force-dynamic";

/**
 * Every breakable item, with what it is worth and whether it has been measured.
 *
 * One page for both questions. What to break next is a filter on this table; so
 * is what is left to measure. They were two pages growing the same columns in
 * parallel — see `catalogueList`.
 */
export default async function ItemsPage() {
  const { rows, jobs, measured, automatic, thresholdPercent } = await catalogueList();

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <PageHeader current="/items" />

      <h1 className="text-heading-lg tracking-heading-lg mt-24">
        {rows.length} items · {measured} measured
      </h1>
      <p className="text-body tracking-body text-sage-40 mt-12 max-w-[78ch]">
        Everything the database knows how to break, valued for an average copy.{" "}
        {automatic ? (
          <>
            Anything clearing{" "}
            <span className="text-phosphor-white">
              {thresholdPercent >= 0 ? "+" : ""}
              {thresholdPercent}%
            </span>{" "}
            against the cheaper of buying and crafting counts as worth breaking, plus
            whatever you marked yourself.
          </>
        ) : (
          <>
            Verdicts are set to <span className="text-phosphor-white">Manual</span>, so
            only your own marks say worth.
          </>
        )}{" "}
        A coefficient belongs to an item type and only a crush reveals it, so a row that
        has never been broken is one the figures are guessing about.
      </p>

      {rows.length === 0 ? (
        <p className="border-circuit-border text-body tracking-body text-sage-40 mt-32 max-w-[74ch] rounded-xl border px-24 py-20">
          Nothing here yet. Pick a job below and load its catalogue, browse gear in the
          HDV with the sniffer running, or run{" "}
          <span className="text-phosphor-white">tools/import_items.py</span>.
        </p>
      ) : (
        <ItemsTable rows={rows} jobs={jobs} />
      )}
    </main>
  );
}
