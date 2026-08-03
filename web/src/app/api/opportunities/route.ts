import { revalidatePath } from "next/cache";
import { loadJobLevelBand } from "@/lib/opportunities";

/**
 * Pull one job's recipes in one level band from DofusDB, on request.
 *
 * Same reasoning as /api/catalogue: a page that did this on every view would
 * ask DofusDB the same question forever, so it is a button instead.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const b = body as { jobId?: unknown; minLevel?: unknown; maxLevel?: unknown };
  const jobId = Number(b?.jobId);
  const minLevel = Number(b?.minLevel);
  const maxLevel = Number(b?.maxLevel);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return Response.json({ error: "bad job id" }, { status: 400 });
  }
  if (
    !Number.isInteger(minLevel) ||
    !Number.isInteger(maxLevel) ||
    minLevel < 1 ||
    maxLevel > 200 ||
    minLevel > maxLevel
  ) {
    return Response.json({ error: "bad level range" }, { status: 400 });
  }

  const result = await loadJobLevelBand(jobId, minLevel, maxLevel);
  revalidatePath("/opportunities");
  return Response.json({ ok: true, ...result });
}
