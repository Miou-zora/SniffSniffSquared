"use client";

import { useRouter } from "next/navigation";

/**
 * A table row that navigates when clicked anywhere in it.
 *
 * A `<tr>` cannot be wrapped in a link, so the row handles the click itself and
 * the item's name stays a real anchor inside it — that keeps middle-click, open
 * in new tab and "copy link" working, which a click handler alone would quietly
 * take away.
 *
 * Ignores clicks that land on a link or a button, so the name's own anchor and
 * anything interactive added later still behave normally, and clicks made while
 * selecting text.
 */
export function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  const router = useRouter();

  return (
    <tr
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        if (window.getSelection()?.toString()) return;
        router.push(href);
      }}
      className="border-phosphor-blue-black hover:bg-carbon-veil cursor-pointer border-b transition-colors duration-150 last:border-0"
    >
      {children}
    </tr>
  );
}
