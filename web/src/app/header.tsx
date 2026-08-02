import Link from "next/link";
import type { ReactNode } from "react";

import { Live } from "@/app/live";
import { ItemSearch } from "@/app/search";

/**
 * The bar every page opens with: the same title on the left, the same routes on
 * the right, always.
 *
 * It used to carry a per-page caption on the left — "in the breaker", "craft
 * basket" — which made every page's header a different header, and said twice
 * what the marked nav entry already says. What the page is belongs in its own
 * heading, below; the bar is furniture and stays put.
 */
const PAGES = [
  { href: "/", label: "breaker" },
  { href: "/worth", label: "worth breaking" },
  { href: "/craft", label: "craft basket" },
  { href: "/broken", label: "coverage" },
] as const;

export type PageHref = (typeof PAGES)[number]["href"];

export function PageHeader({
  current,
  search,
}: {
  current: PageHref;
  /** Replaces the item search, for a page that wants a different one — the
   *  basket's adds to the list rather than navigating away from it. */
  search?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-16">
      <Link
        href="/"
        className="text-caption tracking-caption text-phosphor-white hover:text-lime-pulse font-display uppercase"
      >
        Sniff<span className="text-lime-pulse">Sniff</span>Squared
      </Link>
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
        <div className="w-full sm:w-[24rem] lg:w-[28rem]">{search ?? <ItemSearch />}</div>
        <Live />
      </div>
    </div>
  );
}
