"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ItemSearch } from "@/app/search";
import type { ItemHit } from "@/app/api/items/search/route";

/**
 * The basket's three controls. All of them write the same row and then refresh,
 * so the pile behind them is recomputed on the server — the pooled quantities
 * decide the batch plan, and a client-side estimate of it would disagree with
 * the page as soon as two crafts shared an ingredient.
 */
async function write(body: Record<string, unknown>): Promise<void> {
  await fetch("/api/basket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Search, and add what you pick.
 *
 * Adding something already in the basket raises its count instead of resetting
 * it to one — picking the same item twice reads as "make two of these".
 */
export function AddToBasket({ have }: { have: Record<number, number> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const pick = async (hit: ItemHit) => {
    setBusy(true);
    await write({ itemId: hit.itemId, quantity: (have[hit.itemId] ?? 0) + 1 });
    setBusy(false);
    router.refresh();
  };

  return (
    <div className={busy ? "pointer-events-none opacity-60" : undefined}>
      <ItemSearch onPick={pick} placeholder="Add an item to craft…" />
    </div>
  );
}

export function Quantity({ itemId, quantity }: { itemId: number; quantity: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const set = async (next: number) => {
    setBusy(true);
    await write({ itemId, quantity: Math.max(0, Math.min(999, next)) });
    setBusy(false);
    router.refresh();
  };

  return (
    <div
      className={`flex items-center gap-8 ${busy ? "pointer-events-none opacity-60" : ""}`}
    >
      <Step label="one fewer" onClick={() => set(quantity - 1)}>
        −
      </Step>
      <span className="text-body-sm tracking-body-sm text-phosphor-white w-24 text-center tabular-nums">
        {quantity}
      </span>
      <Step label="one more" onClick={() => set(quantity + 1)}>
        +
      </Step>
      <button
        type="button"
        onClick={() => set(0)}
        className="text-caption tracking-caption text-deep-fern hover:text-phosphor-white ml-8 cursor-pointer uppercase"
      >
        remove
      </button>
    </div>
  );
}

function Step({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="border-circuit-border text-body-sm text-sage-60 hover:border-lime-pulse hover:text-lime-pulse focus-visible:ring-lime-pulse flex h-24 w-24 cursor-pointer items-center justify-center rounded-lg border transition-colors duration-150 outline-none focus-visible:ring-2"
    >
      {children}
    </button>
  );
}

export function ClearBasket() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-caption tracking-caption text-deep-fern hover:text-phosphor-white cursor-pointer uppercase"
      >
        empty the basket
      </button>
    );
  }
  return (
    <span className="text-caption tracking-caption flex items-center gap-12 uppercase">
      <button
        type="button"
        onClick={async () => {
          await write({ clear: true });
          setConfirming(false);
          router.refresh();
        }}
        className="text-lime-pulse cursor-pointer uppercase"
      >
        empty it
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-deep-fern hover:text-phosphor-white cursor-pointer uppercase"
      >
        keep it
      </button>
    </span>
  );
}
