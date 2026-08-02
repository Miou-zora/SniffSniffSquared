import { revalidatePath } from "next/cache";
import { setMark, setMode, setThreshold, type Status } from "@/lib/verdict";

/**
 * The two writes the UI can make: your verdict on one item, and the threshold
 * the automatic verdict uses.
 *
 * Both revalidate the pages that render them, so the badge changes with the
 * click rather than on the next refresh.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const { itemId, status, thresholdPercent, mode } = (body ?? {}) as {
    itemId?: unknown;
    status?: unknown;
    thresholdPercent?: unknown;
    mode?: unknown;
  };

  if (mode !== undefined) {
    if (mode !== "automatic" && mode !== "manual") {
      return Response.json({ error: "bad mode" }, { status: 400 });
    }
    await setMode(mode);
  }

  if (thresholdPercent !== undefined) {
    const v = Number(thresholdPercent);
    // A threshold outside this range is a typo, not a preference — and one
    // stored as NaN would make every item read "skip" with no way to see why.
    if (!Number.isFinite(v) || v < -100 || v > 100_000) {
      return Response.json({ error: "thresholdPercent out of range" }, { status: 400 });
    }
    await setThreshold(v);
  }

  if (itemId !== undefined) {
    const id = Number(itemId);
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "bad itemId" }, { status: 400 });
    }
    if (status !== null && status !== "worth" && status !== "skip") {
      return Response.json({ error: "bad status" }, { status: 400 });
    }
    await setMark(id, status as Status | null);
    revalidatePath(`/item/${id}`);
  }

  revalidatePath("/");
  revalidatePath("/items");
  return Response.json({ ok: true });
}
