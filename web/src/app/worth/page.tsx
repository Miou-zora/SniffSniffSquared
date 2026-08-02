import { redirect } from "next/navigation";

/**
 * `/worth` and `/broken` became one page: the worth list was a filter on the
 * catalogue all along. Kept as redirects because both were linked from
 * elsewhere and a bookmark should not 404 over a refactor.
 */
export default function WorthPage(): never {
  redirect("/items");
}
