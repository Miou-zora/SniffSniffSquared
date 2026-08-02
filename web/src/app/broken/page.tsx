import { BrokenTable } from "@/app/broken/table";
import { PageHeader } from "@/app/header";
import { brokenList } from "@/lib/broken";

// A crush while you play changes this page; nothing here may be prerendered.
export const dynamic = "force-dynamic";

/**
 * Coverage: every breakable item, and whether its coefficient has been read.
 *
 * The coefficient is per item type and only a crush reveals it, so every item
 * that has never been broken is a row every other page is guessing about. This
 * is the list of what is left to measure.
 */
export default async function BrokenPage() {
  const { rows, broken, jobs } = await brokenList();

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <PageHeader current="/broken" />

      <h1 className="text-heading-lg tracking-heading-lg mt-24">
        {broken} of {rows.length} measured
      </h1>
      <p className="text-body tracking-body text-sage-40 mt-12 max-w-[74ch]">
        A coefficient belongs to an item type and only a crush reveals it, so every row
        here that has never been broken is one the rest of the app is guessing about.
        Sorted by level, because that is the order you meet them in.
      </p>

      {rows.length === 0 ? (
        <p className="border-circuit-border text-body tracking-body text-sage-40 mt-32 max-w-[74ch] rounded-xl border px-24 py-20">
          Nothing here yet. This list is built from the item templates the database knows
          — browse gear in the HDV with the sniffer running, or run{" "}
          <span className="text-phosphor-white">tools/import_items.py</span>, and the
          catalogue fills in.
        </p>
      ) : (
        <BrokenTable rows={rows} jobs={jobs} />
      )}
    </main>
  );
}
