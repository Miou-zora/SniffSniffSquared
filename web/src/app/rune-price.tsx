"use client";

import Link from "next/link";
import { useState } from "react";
import { createPortal } from "react-dom";

/** A captured ladder for one rune: x1, x10, x100, x1000. 0 = not on sale. */
export type RuneLadder = [number, number, number, number];

const kamas = new Intl.NumberFormat("fr-FR");
const SIZES = [1, 10, 100, 1000] as const;

/**
 * A rune's name, with what it sells for on hover.
 *
 * The pages quote one number per rune — the x1 price, since that is what a
 * yield multiplies by — and that number is not the whole story: the x10 and
 * x100 quotes are what you would actually sell into, and they are routinely
 * not ten and a hundred times the single. Showing the ladder on hover keeps the
 * columns readable while putting the rest one gesture away.
 *
 * Rendered into a portal at fixed coordinates rather than inside the row: every
 * table it appears in scrolls horizontally, and an absolutely positioned
 * tooltip inside `overflow-x-auto` is clipped by it.
 *
 * Focusable, so the ladder is reachable without a pointer.
 */
export function RunePrice({
  rune,
  ladder,
  itemId,
  className,
}: {
  rune: string;
  /** Null when nothing has been captured for this rune — then it is just text. */
  ladder: RuneLadder | null;
  /** When known, the tooltip points at that rune's price history. */
  itemId?: number | null;
  className?: string;
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  if (ladder === null || ladder.every((p) => p <= 0)) {
    // No captured ladder, so nothing to hover — but a history page still
    // exists if we know which item the rune is.
    return itemId ? (
      <Link
        href={`/price/${itemId}`}
        className={`hover:text-lime-pulse ${className ?? ""}`}
      >
        {rune}
      </Link>
    ) : (
      <span className={className}>{rune}</span>
    );
  }

  // A link when the rune's own page exists, plain text when it does not —
  // same hover either way, so the ladder never depends on which it is.
  const Component = (itemId ? Link : "span") as React.ElementType;

  const show = (el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    setAt({ left: box.left, top: box.bottom + 6 });
  };

  return (
    <Component
      {...(itemId ? { href: `/price/${itemId}` } : { tabIndex: 0 })}
      className={`decoration-circuit-border cursor-help underline decoration-dotted underline-offset-4 outline-none ${className ?? ""}`}
      onPointerEnter={(e: React.PointerEvent<HTMLElement>) => show(e.currentTarget)}
      onPointerLeave={() => setAt(null)}
      onFocus={(e: React.FocusEvent<HTMLElement>) => show(e.currentTarget)}
      onBlur={() => setAt(null)}
    >
      {rune}
      {at !== null &&
        createPortal(
          <span
            role="tooltip"
            style={{ position: "fixed", left: at.left, top: at.top }}
            className="border-circuit-border bg-ground-iron text-caption tracking-caption pointer-events-none z-50 block rounded-xl border px-12 py-8 whitespace-nowrap"
          >
            <span className="text-deep-fern block uppercase">
              {rune} on the market{itemId ? " · click for its history" : ""}
            </span>
            {SIZES.map((size, i) => (
              <span key={size} className="mt-4 flex justify-between gap-16">
                <span className="text-sage-40">x{size}</span>
                <span
                  className={
                    ladder[i] > 0 ? "text-phosphor-white tabular-nums" : "text-deep-fern"
                  }
                >
                  {/* A batch nobody is selling has no price, which is not a
                      price of zero — the distinction decides whether you can
                      sell into it at all. */}
                  {ladder[i] > 0 ? `${kamas.format(ladder[i])} k` : "none on sale"}
                </span>
              </span>
            ))}
          </span>,
          document.body,
        )}
    </Component>
  );
}
