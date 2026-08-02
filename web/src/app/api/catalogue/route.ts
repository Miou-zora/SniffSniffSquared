import { revalidatePath } from "next/cache";
import { loadJobCatalogue } from "@/lib/broken";

/**
 * Pull one job's whole catalogue from DofusDB into the database.
 *
 * Deliberately a request you make rather than something the page does on its
 * own: it is a few hundred rows and a dozen round trips, worth doing once per
 * job and never again, and a page that did it silently on every view would be
 * asking DofusDB the same question forever.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const jobId = Number((body as { jobId?: unknown })?.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return Response.json({ error: "bad job id" }, { status: 400 });
  }

  const result = await loadJobCatalogue(jobId);
  revalidatePath("/broken");
  return Response.json({ ok: true, ...result });
}
