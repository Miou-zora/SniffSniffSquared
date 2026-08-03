"use client";

import Link from "next/link";
import { useState } from "react";
import { createPortal } from "react-dom";

import type { Ladder } from "@/lib/craft";

const kamas = new Intl.NumberFormat("fr-FR");
const SIZES = [
  ["x1", "b1"],
  ["x10", "b10"],
  ["x100", "b100"],
  ["x1000", "b1000"],
] as const;

/**
 * An item's name, with its full batch ladder on hover — one x1 number quoted
 * inline is not the whole story: a bigger batch routinely prices lower per
 * unit, and buying (or valuing) at the wrong size reads a cheap ingredient as
 * an expensive one. The cheapest per-unit rate is marked, since that is the
 * rate worth buying at.
 *
 * Same interaction as `RunePrice` (portal-rendered tooltip, so it survives an
 * `overflow-x-auto` ancestor; focusable, so it works without a pointer), kept
 * separate because that one's copy is rune-specific.
 */
export function ItemPrice({
  name,
  ladder,
  itemId,
  className,
}: {
  name: string;
  /** Null when nothing has been captured for this item — then it is just text. */
  ladder: Ladder | null;
  /** When known, the tooltip points at that item's price history. */
  itemId?: number | null;
  className?: string;
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  const quoted = ladder ? SIZES.map(([, key]) => ladder[key]).filter((p) => p > 0) : [];
  if (ladder === null || quoted.length === 0) {
    return itemId ? (
      <Link
        href={`/item/${itemId}`}
        className={`hover:text-lime-pulse ${className ?? ""}`}
      >
        {name}
      </Link>
    ) : (
      <span className={className}>{name}</span>
    );
  }

  // The best per-unit rate among what is quoted — same "cheapest wins" rule
  // `unitPrice` uses, so the tooltip and the number it explains never disagree.
  const bestRate = Math.min(
    ...SIZES.map(([, key], i) =>
      ladder[key] > 0 ? ladder[key] / [1, 10, 100, 1000][i] : Infinity,
    ),
  );

  const Component = (itemId ? Link : "span") as React.ElementType;

  const show = (el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    setAt({ left: box.left, top: box.bottom + 6 });
  };

  return (
    <Component
      {...(itemId ? { href: `/item/${itemId}` } : { tabIndex: 0 })}
      className={`decoration-circuit-border cursor-help underline decoration-dotted underline-offset-4 outline-none ${className ?? ""}`}
      onPointerEnter={(e: React.PointerEvent<HTMLElement>) => show(e.currentTarget)}
      onPointerLeave={() => setAt(null)}
      onFocus={(e: React.FocusEvent<HTMLElement>) => show(e.currentTarget)}
      onBlur={() => setAt(null)}
    >
      {name}
      {at !== null &&
        createPortal(
          <span
            role="tooltip"
            style={{ position: "fixed", left: at.left, top: at.top }}
            className="border-circuit-border bg-ground-iron text-caption tracking-caption pointer-events-none z-50 block rounded-xl border px-12 py-8 whitespace-nowrap"
          >
            <span className="text-deep-fern block uppercase">
              {name} on the market{itemId ? " · click for its page" : ""}
            </span>
            {SIZES.map(([label, key], i) => {
              const price = ladder[key];
              const rate = price > 0 ? price / [1, 10, 100, 1000][i] : null;
              const best = rate !== null && rate === bestRate;
              return (
                <span key={key} className="mt-4 flex justify-between gap-16">
                  <span className="text-sage-40">{label}</span>
                  <span
                    className={
                      best
                        ? "text-lime-pulse tabular-nums"
                        : price > 0
                          ? "text-phosphor-white tabular-nums"
                          : "text-deep-fern"
                    }
                  >
                    {/* A batch nobody is selling has no price, which is not a
                        price of zero — the distinction decides whether you can
                        buy or sell into it at all. */}
                    {price > 0 ? `${kamas.format(price)} k` : "none on sale"}
                    {best ? " · best" : ""}
                  </span>
                </span>
              );
            })}
          </span>,
          document.body,
        )}
    </Component>
  );
}
