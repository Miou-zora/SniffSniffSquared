import { redirect } from "next/navigation";

/**
 * The price history moved onto the item's own page: two pages for one item was
 * two half-answers, and for a rune the price *is* the item's page. Kept as a
 * redirect because the rune tooltips linked here.
 */
export default async function PricePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/item/${id}`);
}
