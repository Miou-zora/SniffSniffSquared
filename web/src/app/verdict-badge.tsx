"use client";

import { useState } from "react";
import { Drawer, Field, Segmented, useVerdictPost, VerdictSettings } from "@/app/drawer";
import type { Status, Verdict } from "@/lib/verdict";

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
  const [open, setOpen] = useState(false);
  const { post, pending } = useVerdictPost();

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

      <Drawer open={open} onClose={() => setOpen(false)} title="Worth breaking?">
        {verdict.assumed && (
          <p className="text-body-sm tracking-body-sm text-sage-40 mt-16">
            <span className="text-phosphor-white">No crush of this item captured</span>,
            so its coefficient is unknown — and every rune figure scales with it. Real
            ones in this capture run from 16% to 150%, so there is no verdict to give
            until one is observed. Crush one with the sniffer running, or read the figures
            below as the 100% case.
          </p>
        )}
        <p className="text-body-sm tracking-body-sm text-sage-40 mt-16">
          {verdict.profit !== null ? (
            <>
              These runes fetch{" "}
              <span className="text-phosphor-white tabular-nums">
                {verdict.profit >= 0 ? "+" : ""}
                {fmt(verdict.profit, 1)}%
              </span>{" "}
              against the cheaper of buying and crafting, taking the better of focusing
              and not{verdict.assumed && ", at an assumed 100% coefficient"}.
            </>
          ) : verdict.missing === "cost" ? (
            "No price for a copy, so there is nothing to measure the runes against."
          ) : (
            "No rune prices captured, so the runes cannot be valued yet."
          )}
        </p>

        <VerdictSettings
          mode={verdict.mode}
          thresholdPercent={verdict.thresholdPercent}
        />

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
      </Drawer>
    </>
  );
}
