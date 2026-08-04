import { PageHeader } from "@/app/header";
import { OpportunitiesTable } from "@/app/opportunities/table";
import { loadOpportunities } from "@/lib/opportunities";

// A price capture or a job load while browsing changes this page; nothing may
// be prerendered.
export const dynamic = "force-dynamic";

/**
 * Which consumable/resource recipes are worth crafting and selling right now,
 * per job. Equipment and runes are out of scope on purpose — see
 * docs/superpowers/specs/2026-08-03-craft-opportunities-dashboard-design.md.
 */
export default async function OpportunitiesPage() {
  const { rows, jobs, nuggetPrice } = await loadOpportunities();

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <PageHeader current="/opportunities" />

      <h1 className="text-heading-lg tracking-heading-lg mt-24">
        {rows.length} item{rows.length === 1 ? "" : "s"} known
      </h1>
      <p className="text-body tracking-body text-sage-40 mt-12 max-w-[78ch]">
        Consommables and resources — equipment is answered by the breaker and items pages
        instead. Cost is the ingredients off the batch ladder; sale price is the cheapest
        rate currently quoted for the item itself. No HDV sales tax is factored in.{" "}
        <span className="text-deep-fern">
          Recycle is the same unit valued as nuggets instead —{" "}
          {nuggetPrice === null
            ? "no nugget price captured yet, so the column is empty"
            : `at ${Math.round(nuggetPrice).toLocaleString("fr-FR")} k a nugget`}
          . Whichever of the two pays more is the one shown in white. Rows a job does not
          make — dropped resources, runes — are here for that column alone and carry no
          cost or margin; the craftable chip hides them.
        </span>
      </p>

      {rows.length === 0 ? (
        <p className="border-circuit-border text-body tracking-body text-sage-40 mt-32 max-w-[74ch] rounded-xl border px-24 py-20">
          Nothing here yet. Pick a job below and load a level band, or run{" "}
          <span className="text-phosphor-white">tools/import_items.py</span>.
        </p>
      ) : (
        <OpportunitiesTable rows={rows} jobs={jobs} />
      )}
    </main>
  );
}
