import Link from "next/link";
import type { ReactNode } from "react";

import { Live } from "@/app/live";
import { ItemSearch } from "@/app/search";

/**
 * The bar every page opens with: where you are on the left, where else you can
 * go on the right.
 *
 * One component rather than three, because three drifted — each page linked to
 * a different pair of the others, so which routes existed depended on which one
 * you happened to be looking at. The nav here is the whole site, always, with
 * the page you are on marked instead of linked.
 */
const PAGES = [
  { href: "/", label: "breaker" },
  { href: "/worth", label: "worth breaking" },
  { href: "/craft", label: "craft basket" },
] as const;

export type PageHref = (typeof PAGES)[number]["href"];

export function PageHeader({
  label,
  current,
  search,
}: {
  /** What this page is, in the caption slot. Not always the nav's word for it:
   *  the breaker says "browsing an item" when you arrived from a search. */
  label: string;
  current: PageHref;
  /** Replaces the item search, for a page that wants a different one — the
   *  basket's adds to the list rather than navigating away from it. */
  search?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-16">
      <p className="text-caption tracking-caption text-moss-70 uppercase">{label}</p>
      <div className="flex flex-wrap items-center justify-end gap-16">
        <nav className="flex flex-wrap items-center gap-16">
          {PAGES.map((page) =>
            page.href === current ? (
              <span
                key={page.href}
                aria-current="page"
                className="text-caption tracking-caption text-phosphor-white uppercase"
              >
                {page.label}
              </span>
            ) : (
              <Link
                key={page.href}
                href={page.href}
                className="text-caption tracking-caption text-fern-link hover:text-lime-pulse uppercase"
              >
                {page.label}
              </Link>
            ),
          )}
        </nav>
        {search ?? <ItemSearch />}
        <Live />
      </div>
    </div>
  );
}
