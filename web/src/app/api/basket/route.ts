import { revalidatePath } from "next/cache";
import { addJobRange, clearBasket, setBasket } from "@/lib/basket";

/**
 * The craft basket's writes: how many copies of an item to make, everything a
 * job makes in a level band, and emptying it. A quantity of 0 removes the
 * entry, so add, change and remove are one call rather than three verbs over
 * the same row.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const { itemId, quantity, clear, job } = (body ?? {}) as {
    itemId?: unknown;
    quantity?: unknown;
    clear?: unknown;
    job?: unknown;
  };

  if (clear === true) {
    await clearBasket();
    revalidatePath("/craft");
    return Response.json({ ok: true });
  }

  if (job !== undefined) {
    const { id, minLevel, maxLevel } = (job ?? {}) as {
      id?: unknown;
      minLevel?: unknown;
      maxLevel?: unknown;
    };
    const jobId = Number(id);
    const min = Number(minLevel);
    const max = Number(maxLevel);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return Response.json({ error: "bad job id" }, { status: 400 });
    }
    // 1-200 is the game's range, and a reversed band would silently match
    // nothing rather than the levels that were meant.
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 200) {
      return Response.json({ error: "level out of range" }, { status: 400 });
    }
    if (min > max) {
      return Response.json({ error: "levels are the wrong way round" }, { status: 400 });
    }
    const result = await addJobRange(jobId, min, max);
    revalidatePath("/craft");
    return Response.json({ ok: true, ...result });
  }

  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "bad itemId" }, { status: 400 });
  }
  const q = Number(quantity);
  // Capped rather than unbounded: a mistyped quantity would multiply every
  // ingredient line and print a shopping list nobody could act on.
  if (!Number.isInteger(q) || q < 0 || q > 999) {
    return Response.json({ error: "bad quantity" }, { status: 400 });
  }

  await setBasket(id, q);
  revalidatePath("/craft");
  return Response.json({ ok: true });
}
