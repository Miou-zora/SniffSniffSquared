"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ItemHit } from "@/app/api/items/search/route";

/**
 * Item picker, so the page can answer for an item you do not hold.
 *
 * Results are marked by whether the wire has seen the id: those carry captured
 * stats and prices, the rest are DofusDB names whose page will lean on the
 * template. Saying which is which up front beats letting someone pick a name
 * and find an empty projection.
 */
export function ItemSearch() {
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

  return (
    <div ref={box} className="relative w-full max-w-[22rem]">
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
        placeholder="Search an item…"
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
                  router.push(`/item/${hit.itemId}`);
                }}
                className="hover:bg-carbon-veil flex w-full cursor-pointer items-baseline justify-between gap-12 px-16 py-12 text-left"
              >
                <span className="text-body-sm tracking-body-sm text-phosphor-white">
                  {hit.name}
                </span>
                <span className="text-caption tracking-caption text-deep-fern shrink-0">
                  {hit.level !== null && `lvl ${hit.level}`}
                  {hit.type !== null && ` · ${hit.type}`}
                  {hit.known && <span className="text-moss-70"> · captured</span>}
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
