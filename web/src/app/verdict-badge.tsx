"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Mode, Status, Verdict } from "@/lib/verdict";

const fmt = (v: number, digits: number) =>
  v.toLocaleString("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const LABEL: Record<Status, string> = {
  worth: "worth breaking",
  skip: "not worth breaking",
};

/**
 * Whether this item is worth breaking, and the settings behind that answer.
 *
 * The verdict is one line, so it lives inline beside the item's name rather
 * than in a panel of its own — it competes with the projection table for
 * attention, and it should lose. Everything you might change about it is a
 * click away in a drawer instead of occupying the page permanently.
 */
export function VerdictBadge({ itemId, verdict }: { itemId: number; verdict: Verdict }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [threshold, setThresholdInput] = useState(String(verdict.thresholdPercent));

  const post = (body: Record<string, unknown>) =>
    startTransition(async () => {
      await fetch("/api/verdict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      router.refresh();
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const tone =
    verdict.status === "worth"
      ? "border-lime-pulse text-lime-pulse"
      : verdict.status === "skip"
        ? "border-circuit-border text-sage-40"
        : "border-circuit-border text-deep-fern";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="How this verdict is decided"
        aria-expanded={open}
        className={`text-caption tracking-caption hover:bg-carbon-veil cursor-pointer rounded-lg border px-12 py-8 font-medium uppercase transition-colors duration-150 ${tone}`}
      >
        {verdict.status === null ? "no verdict" : LABEL[verdict.status]}
        {verdict.profit !== null && (
          <span className="tabular-nums normal-case">
            {" "}
            {verdict.profit >= 0 ? "+" : ""}
            {fmt(verdict.profit, 0)}%
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-20 bg-black/50"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}
      <aside
        // Rendered always, translated off-screen when shut, so it slides rather
        // than appearing. inert while hidden keeps it out of the tab order.
        inert={!open}
        aria-label="verdict settings"
        className={`border-circuit-border bg-ground-iron fixed top-0 right-0 z-30 h-full w-full max-w-[24rem] overflow-y-auto border-l p-24 transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between gap-16">
          <h2 className="text-subheading tracking-subheading">Worth breaking?</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-body-sm text-fern-link hover:text-phosphor-white cursor-pointer"
          >
            close
          </button>
        </div>

        <p className="text-body-sm tracking-body-sm text-sage-40 mt-16">
          {verdict.profit !== null ? (
            <>
              These runes fetch{" "}
              <span className="text-phosphor-white tabular-nums">
                {verdict.profit >= 0 ? "+" : ""}
                {fmt(verdict.profit, 1)}%
              </span>{" "}
              against what a copy costs, taking the better of focusing and not.
            </>
          ) : verdict.missing === "cost" ? (
            "No price for a copy, so there is nothing to measure the runes against."
          ) : (
            "No rune prices captured, so the runes cannot be valued yet."
          )}
        </p>

        <Field label="verdict">
          <Segmented<Mode>
            value={verdict.mode}
            options={[
              ["automatic", "Automatic"],
              ["manual", "Manual"],
            ]}
            disabled={pending}
            onChange={(next) => post({ mode: next })}
          />
        </Field>
        <p className="text-body-sm tracking-body-sm text-deep-fern mt-8">
          {verdict.mode === "automatic"
            ? "Every item is judged by the threshold below. Anything you mark yourself still wins."
            : "Nothing is judged for you — only the items you mark carry a verdict."}
        </p>

        {verdict.mode === "automatic" && (
          <Field label="mark as worth over">
            <span className="text-body-sm tracking-body-sm text-sage-40 flex items-center gap-8">
              <input
                type="number"
                inputMode="decimal"
                value={threshold}
                onChange={(e) => setThresholdInput(e.target.value)}
                onBlur={() => {
                  const v = Number.parseFloat(threshold.replace(",", "."));
                  if (Number.isFinite(v) && v !== verdict.thresholdPercent) {
                    post({ thresholdPercent: v });
                  }
                }}
                aria-label="worth-breaking threshold, percent"
                className="border-circuit-border focus:border-lime-pulse text-body-sm text-phosphor-white w-64 border-0 border-b bg-transparent px-0 py-4 text-right tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              % profit
            </span>
          </Field>
        )}

        <Field label="this item">
          <Segmented<Status | "auto">
            value={verdict.manual ? (verdict.status ?? "auto") : "auto"}
            options={[
              ["auto", verdict.mode === "automatic" ? "Automatic" : "None"],
              ["worth", "Worth it"],
              ["skip", "Skip"],
            ]}
            disabled={pending}
            onChange={(next) => post({ itemId, status: next === "auto" ? null : next })}
          />
        </Field>
        {verdict.manual && verdict.automatic !== null && (
          <p className="text-body-sm tracking-body-sm text-deep-fern mt-8">
            Overriding {LABEL[verdict.automatic]}, which is what the threshold says.
          </p>
        )}
      </aside>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-24">
      <p className="text-caption tracking-caption text-deep-fern mb-8 uppercase">
        {label}
      </p>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  disabled,
  onChange,
}: {
  value: T;
  options: [T, string][];
  disabled: boolean;
  onChange: (next: T) => void;
}) {
  return (
    <div className="border-circuit-border bg-void-black flex rounded-xl border p-4">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={`text-body-sm tracking-body-sm flex-1 rounded-lg px-12 py-8 font-medium transition-colors duration-150 ${
            value === id
              ? "bg-lime-pulse text-void-black"
              : "text-sage-60 hover:bg-carbon-veil hover:text-phosphor-white cursor-pointer"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
