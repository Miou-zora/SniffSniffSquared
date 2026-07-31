import { notFound } from "next/navigation";
import { ItemView } from "@/app/page";
import { loadItem } from "@/lib/breaker";

// Prices and crushes land while you play, so this is never prerendered — the
// same reason the breaker page is not.
export const dynamic = "force-dynamic";

/**
 * Any item, whether or not you hold one.
 *
 * The breaker page answers "what is the thing in front of me worth"; this one
 * answers "what would that item be worth", which is the question you have
 * before buying one to break.
 */
export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const itemId = Number.parseInt(id, 10);
  const view = await loadItem(itemId);
  if (!view) notFound();
  return <ItemView view={view} />;
}
