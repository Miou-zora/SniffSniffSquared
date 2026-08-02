"use client";

import { useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { ItemHit } from "@/app/api/items/search/route";
import { iconUrl } from "@/lib/icon";

/**
 * Item picker, so the page can answer for an item you do not hold.
 *
 * Results are marked by whether the wire has seen the id: those carry captured
 * stats and prices, the rest are DofusDB names whose page will lean on the
 * template. Saying which is which up front beats letting someone pick a name
 * and find an empty projection.
 *
 * Picking an item opens its page, unless a caller wants the hit instead — the
 * craft basket adds it rather than navigating away from the list being built.
 */
export function ItemSearch({
  onPick,
  placeholder = "Search an item…",
}: {
  onPick?: (hit: ItemHit) => void;
  placeholder?: string;
} = {}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ItemHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const inputId = useId();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // No setState on the way out: clearing the list synchronously here would
    // cascade a render for every keystroke below the threshold. What is shown
    // is derived from `q` instead.
    if (q.trim().length < 2) return;
    // Debounced and abortable: a search box fires on every keystroke, and
    // without the abort a slow early request can land after a fast later one
    // and overwrite the results with the wrong ones.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(`/api/items/search?q=${encodeURIComponent(q.trim())}`, {
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((d: { items?: ItemHit[] }) => {
          setHits(d.items ?? []);
          setOpen(true);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const results = q.trim().length < 2 ? [] : hits;

  // Fills whatever it is given. The width lives on the slot in `PageHeader`,
  // so a search that is wrapped in something and one that is not come out the
  // same size — as a bare flex child `w-full` resolved against the whole row
  // and pushed itself onto a line of its own.
  return (
    <div ref={box} className="relative w-full">
      <label htmlFor={inputId} className="sr-only">
        search an item
      </label>
      <input
        id={inputId}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder={placeholder}
        className="border-circuit-border focus:border-lime-pulse text-body-sm tracking-body-sm text-phosphor-white placeholder:text-deep-fern bg-ground-iron w-full rounded-xl border px-16 py-12 outline-none"
      />
      {open && (results.length > 0 || loading) && (
        <ul className="border-circuit-border bg-ground-iron absolute z-10 mt-4 w-full overflow-hidden rounded-xl border">
          {results.map((hit) => (
            <li key={hit.itemId}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (onPick) {
                    onPick(hit);
                    setQ("");
                    return;
                  }
                  router.push(`/item/${hit.itemId}`);
                }}
                className="hover:bg-carbon-veil flex w-full cursor-pointer items-center justify-between gap-12 px-16 py-12 text-left"
              >
                <span className="flex min-w-0 items-center gap-12">
                  {/* The icon is what you recognise; the name is what you had to
                      remember. Items with none keep the square so the list of
                      names stays a column. */}
                  {hit.iconId === null ? (
                    <span aria-hidden className="block h-24 w-24 shrink-0" />
                  ) : (
                    <Image
                      src={iconUrl(hit.iconId)}
                      alt=""
                      width={24}
                      height={24}
                      className="shrink-0"
                      unoptimized
                    />
                  )}
                  <span className="text-body-sm tracking-body-sm text-phosphor-white truncate">
                    {hit.name}
                  </span>
                </span>
                <span className="text-caption tracking-caption text-deep-fern shrink-0">
                  {hit.level !== null && `lvl ${hit.level}`}
                  {hit.type !== null && ` · ${hit.type}`}
                  {hit.known && <span className="text-moss-70"> · captured</span>}
                  {hit.mark === "worth" && (
                    <span className="text-lime-pulse"> · worth breaking</span>
                  )}
                  {hit.mark === "skip" && <span className="text-sage-40"> · skip</span>}
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 && loading && (
            <li className="text-body-sm tracking-body-sm text-deep-fern px-16 py-12">
              searching…
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
