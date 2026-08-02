import { revalidatePath } from "next/cache";
import { clearBasket, setBasket } from "@/lib/basket";

/**
 * The craft basket's writes: how many copies of an item to make, and emptying
 * it. A quantity of 0 removes the entry, so add, change and remove are one
 * call rather than three verbs over the same row.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const { itemId, quantity, clear } = (body ?? {}) as {
    itemId?: unknown;
    quantity?: unknown;
    clear?: unknown;
  };

  if (clear === true) {
    await clearBasket();
    revalidatePath("/craft");
    return Response.json({ ok: true });
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
