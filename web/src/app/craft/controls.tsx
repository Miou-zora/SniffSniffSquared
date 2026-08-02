"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ItemSearch } from "@/app/search";
import type { ItemHit } from "@/app/api/items/search/route";
import type { JobOption } from "@/lib/basket";

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

/**
 * Add a whole job's output in a level band — every Bijoutier recipe from 41 to
 * 45, say. Levelling a craft job means making one of everything in the band,
 * and adding sixty items by hand is the reason nobody prices the trip first.
 *
 * Items already in the basket keep the quantity you set; the report says how
 * many were new so it is clear nothing was overwritten.
 */
export function BulkAdd({ jobs }: { jobs: JobOption[] }) {
  const router = useRouter();
  const [jobId, setJobId] = useState<number | "">("");
  const [min, setMin] = useState("1");
  const [max, setMax] = useState("200");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);

  if (jobs.length === 0) return null;

  const bounds = () => {
    const lo = Number.parseInt(min, 10);
    const hi = Number.parseInt(max, 10);
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    if (lo < 1 || hi > 200 || lo > hi) return null;
    return { lo, hi };
  };
  const range = bounds();
  const ready = jobId !== "" && range !== null && !busy;

  const add = async () => {
    if (!ready || range === null) return;
    setBusy(true);
    setReport(null);
    const res = await fetch("/api/basket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job: { id: jobId, minLevel: range.lo, maxLevel: range.hi },
      }),
    });
    const body: {
      found?: number;
      added?: number;
      levels?: [number, number] | null;
      error?: string;
    } = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setReport(body.error ?? "that did not work");
      return;
    }
    const found = body.found ?? 0;
    const added = body.added ?? 0;
    // Both ends of the band are inclusive, and the levels actually found say so
    // out loud -- a band whose top level simply has no recipes is otherwise
    // indistinguishable from one that was quietly cut short.
    const span = body.levels ? ` · levels ${body.levels[0]}–${body.levels[1]}` : "";
    setReport(
      found === 0
        ? "nothing is crafted in that range"
        : added === 0
          ? `all ${found} were already in the basket${span}`
          : `added ${added} of ${found}${added < found ? ", rest already in" : ""}${span}`,
    );
    router.refresh();
  };

  return (
    <div className="border-circuit-border rounded-2xl border px-20 py-16">
      <div className="flex flex-wrap items-end gap-16">
        <Field label="job">
          <select
            value={jobId}
            onChange={(e) =>
              setJobId(e.target.value === "" ? "" : Number(e.target.value))
            }
            className="border-circuit-border focus:border-lime-pulse text-body-sm tracking-body-sm text-phosphor-white bg-ground-iron cursor-pointer rounded-xl border px-12 py-8 outline-none"
          >
            <option value="">pick one…</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        </Field>
        {/* "including" rather than "to": both ends are inclusive, and a plain
            "to 45" reads as a stop sign to half the people who see it. */}
        <Field label="from level">
          <Level value={min} onChange={setMin} />
        </Field>
        <Field label="up to and including">
          <Level value={max} onChange={setMax} />
        </Field>
        <button
          type="button"
          onClick={add}
          disabled={!ready}
          className="border-circuit-border text-body-sm tracking-body-sm text-lime-pulse hover:border-lime-pulse focus-visible:ring-lime-pulse cursor-pointer rounded-xl border px-16 py-8 transition-colors duration-150 outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "adding…" : "add all"}
        </button>
        {report !== null && (
          <span className="text-caption tracking-caption text-moss-70">{report}</span>
        )}
      </div>
      {range === null && (
        <p className="text-caption tracking-caption text-sage-40 mt-8">
          Levels run 1 to 200, low to high.
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-4">
      <span className="text-caption tracking-caption text-deep-fern uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

function Level({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="number"
      min={1}
      max={200}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border-circuit-border focus:border-lime-pulse text-body-sm tracking-body-sm text-phosphor-white bg-ground-iron w-64 rounded-xl border px-12 py-8 tabular-nums outline-none"
    />
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
