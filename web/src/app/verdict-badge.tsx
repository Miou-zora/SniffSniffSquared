"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Status, Verdict } from "@/lib/verdict";

const fmt = (v: number, digits: number) =>
  v.toLocaleString("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/**
 * Whether this item is worth breaking, and the controls to disagree.
 *
 * The verdict is arithmetic — what the runes fetch against what a copy costs,
 * over a threshold you set — so it is shown with the number behind it. A badge
 * that says "worth breaking" without saying by how much cannot be checked, and
 * one that cannot be checked gets trusted in cases where it should not be.
 */
export function VerdictBadge({ itemId, verdict }: { itemId: number; verdict: Verdict }) {
  const router = useRouter();
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

  const mark = (status: Status | null) => post({ itemId, status });

  const tone =
    verdict.status === "worth"
      ? "border-lime-pulse text-lime-pulse"
      : verdict.status === "skip"
        ? "border-circuit-border text-sage-40"
        : "border-circuit-border text-deep-fern";

  return (
    <section className="border-circuit-border bg-ground-iron mt-24 rounded-2xl border p-24">
      <div className="flex flex-wrap items-center gap-x-16 gap-y-12">
        <span
          className={`text-caption tracking-caption rounded-lg border px-12 py-8 font-medium uppercase ${tone}`}
        >
          {verdict.status === "worth"
            ? "worth breaking"
            : verdict.status === "skip"
              ? "not worth breaking"
              : "no verdict"}
        </span>

        {verdict.profit !== null ? (
          <p className="text-body-sm tracking-body-sm text-sage-40">
            Runes fetch{" "}
            <span className="text-phosphor-white tabular-nums">
              {verdict.profit >= 0 ? "+" : ""}
              {fmt(verdict.profit, 1)}%
            </span>{" "}
            against what a copy costs, threshold {fmt(verdict.thresholdPercent, 0)}%
            {verdict.manual && (
              <span className="text-deep-fern">
                {" "}
                · set by you, overriding{" "}
                {verdict.automatic === "worth"
                  ? "worth breaking"
                  : verdict.automatic === "skip"
                    ? "not worth breaking"
                    : "no verdict"}
              </span>
            )}
          </p>
        ) : (
          <p className="text-body-sm tracking-body-sm text-sage-40">
            {verdict.missing === "cost"
              ? "No price for a copy, so there is nothing to measure the runes against."
              : "No rune prices captured, so the runes cannot be valued yet."}
            {verdict.manual && <span className="text-deep-fern"> · marked by you</span>}
          </p>
        )}
      </div>

      <div className="mt-16 flex flex-wrap items-center gap-x-16 gap-y-12">
        <div className="border-circuit-border bg-void-black flex rounded-xl border p-4">
          {(
            [
              ["worth", "Worth it"],
              ["skip", "Skip"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={pending}
              aria-pressed={verdict.manual && verdict.status === value}
              onClick={() => mark(value)}
              className={`text-body-sm tracking-body-sm rounded-lg px-16 py-8 font-medium transition-colors duration-150 ${
                verdict.manual && verdict.status === value
                  ? "bg-lime-pulse text-void-black"
                  : "text-sage-60 hover:bg-carbon-veil hover:text-phosphor-white cursor-pointer"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {verdict.manual && (
          <button
            type="button"
            disabled={pending}
            onClick={() => mark(null)}
            className="text-body-sm tracking-body-sm text-fern-link hover:text-phosphor-white cursor-pointer underline"
          >
            back to automatic
          </button>
        )}

        <label className="text-body-sm tracking-body-sm text-sage-40 ml-auto flex items-center gap-8">
          mark as worth over
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
            className="border-circuit-border focus:border-lime-pulse text-body-sm text-phosphor-white w-48 border-0 border-b bg-transparent px-0 py-4 text-right tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          % profit
        </label>
      </div>
    </section>
  );
}
