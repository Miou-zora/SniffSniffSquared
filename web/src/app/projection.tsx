"use client";

import { useMemo, useState, useId } from "react";
import { COEFFICIENT_STEPS, decay, profitPercent, runeCount } from "@/lib/brisage";
import type { ProjectionModel } from "@/lib/breaker";

type Metric = "runes" | "value" | "profit";

const METRICS: { id: Metric; label: string; hint: string }[] = [
  { id: "runes", label: "Runes", hint: "how many runes each focus produces" },
  { id: "value", label: "Kamas", hint: "what those runes sell for" },
  { id: "profit", label: "% vs item", hint: "profit against what the item cost" },
];

const fmt = (v: number, digits: number) =>
  v.toLocaleString("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/**
 * Profit needs more precision than it looks.
 *
 * An item worth far more than its runes lands just above -100%, and at zero
 * decimals that renders as a flat "-100%" — indistinguishable from a sentinel
 * for missing data, which is exactly how it gets misread. Below -99 the extra
 * digits are the whole message, so keep them.
 */
function formatProfit(p: number): string {
  const digits = p < -99 ? 2 : Math.abs(p) >= 100 ? 0 : 1;
  return `${p >= 0 ? "+" : ""}${fmt(p, digits)}%`;
}

export function Projection({ model }: { model: ProjectionModel }) {
  const [metric, setMetric] = useState<Metric>("runes");
  const [customX, setCustomX] = useState("");
  const inputId = useId();

  const priced = model.focuses.some((f) => f.unitPrice !== null);
  const canProfit = priced && model.itemCost !== null;

  const customCoefficient = useMemo(() => {
    const x = Number.parseInt(customX, 10);
    if (!Number.isFinite(x) || x < 1 || x > 100_000) return null;
    return decay(model.coefficient, x);
  }, [customX, model.coefficient]);

  const columns = useMemo(
    () => [
      { label: "100%", coefficient: 100 },
      ...COEFFICIENT_STEPS.map((s) => ({
        label: s === 0 ? "n" : `n+${s}`,
        coefficient: decay(model.coefficient, s),
      })),
    ],
    [model.coefficient],
  );

  /** Cell values for one row, across the fixed columns plus the custom one. */
  const cellsFor = (
    at: (coefficient: number) => { runes: number; value: number | null },
  ) => [
    ...columns.map((c) => at(c.coefficient)),
    customCoefficient === null ? null : at(customCoefficient),
  ];

  const rows = useMemo(() => {
    const focusRows = model.focuses.map((f) => ({
      key: String(f.effectId),
      label: f.rune,
      unpriced: f.unitPrice === null,
      cells: cellsFor((coefficient) => {
        const runes = runeCount(f.focusWeight, f.runeWeight, coefficient);
        return { runes, value: f.unitPrice === null ? null : runes * f.unitPrice };
      }),
    }));

    const noFocus = {
      key: "no-focus",
      label: "no focus",
      unpriced: model.noFocusLines.every((l) => l.unitPrice === null),
      cells: cellsFor((coefficient) => {
        let runes = 0;
        let value: number | null = null;
        for (const l of model.noFocusLines) {
          const r = runeCount(l.weight, l.runeWeight, coefficient);
          runes += r;
          if (l.unitPrice !== null) value = (value ?? 0) + r * l.unitPrice;
        }
        return { runes, value };
      }),
    };

    return [...focusRows, noFocus];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, columns, customCoefficient]);

  return (
    <section className="border-circuit-border overflow-hidden rounded-2xl border">
      <div className="border-phosphor-blue-black flex flex-wrap items-center justify-between gap-x-24 gap-y-12 border-b px-20 py-16">
        {/* A segmented control, so every state has the same box: the weight and
            padding never change between active and idle, only the colours. A
            font-weight that only the active button carries reflows the group on
            every click, which reads as the switch being broken. */}
        <div
          role="group"
          aria-label="metric"
          className="border-circuit-border bg-ground-iron flex rounded-xl border p-4"
        >
          {METRICS.map((m) => {
            const disabled =
              (m.id === "value" && !priced) || (m.id === "profit" && !canProfit);
            const active = metric === m.id;
            return (
              <button
                key={m.id}
                type="button"
                // aria-disabled rather than disabled: a disabled button swallows
                // pointer events, so the title saying *why* it is off would never
                // appear — which is the one moment it is worth reading.
                aria-disabled={disabled || undefined}
                aria-pressed={active}
                onClick={() => !disabled && setMetric(m.id)}
                title={
                  disabled
                    ? m.id === "value"
                      ? "No rune prices captured yet"
                      : "No price captured for this item"
                    : m.hint
                }
                className={`text-body-sm tracking-body-sm focus-visible:ring-lime-pulse rounded-lg px-16 py-12 font-medium transition-colors duration-150 outline-none focus-visible:ring-2 ${
                  active
                    ? "bg-lime-pulse text-void-black"
                    : disabled
                      ? "text-deep-fern cursor-not-allowed"
                      : "text-sage-60 hover:bg-carbon-veil hover:text-phosphor-white cursor-pointer"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <p className="text-body-sm tracking-body-sm text-sage-40">
          {METRICS.find((m) => m.id === metric)?.hint}, as the coefficient decays.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-left">
          <thead>
            <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b align-bottom uppercase">
              <th className="py-12 pr-16 pl-20 font-medium">focus</th>
              {/* Padding is symmetric on the numeric columns. With a left-only
                  pad, right-aligned figures end flush on the cell edge, which
                  puts n+1000 hard against the custom column's rule. */}
              {columns.map((c) => (
                <th key={c.label} className="py-12 pr-16 pl-16 font-medium">
                  <span className="text-moss-70 flex h-24 items-center justify-end">
                    {c.label}
                  </span>
                  <span className="text-deep-fern mt-4 block text-right normal-case">
                    {fmt(c.coefficient, 2)}%
                  </span>
                </th>
              ))}
              {/* The custom column is always present, so the table looks the
                  same before and after a value is typed. Its header carries an
                  input where the others carry text, so the input is stripped to
                  an underline: a bordered box would inset the digits by its own
                  padding and stand them off the column they label, and its
                  height would push the coefficient line below every other one. */}
              <th className="border-phosphor-blue-black border-l py-12 pr-20 pl-20 font-medium">
                <label
                  htmlFor={inputId}
                  className="text-lime-pulse flex h-24 items-center justify-end gap-4"
                >
                  n+
                  <input
                    id={inputId}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100000}
                    value={customX}
                    onChange={(e) => setCustomX(e.target.value)}
                    placeholder="x"
                    aria-label="custom number of runes"
                    // text-caption, not text-body-sm: the other column labels
                    // are 12px with caption tracking, and a 14px negatively
                    // tracked number beside them is what makes this column read
                    // as sitting apart from the rest of the header.
                    className="border-circuit-border focus:border-lime-pulse text-caption tracking-caption text-phosphor-white placeholder:text-deep-fern w-48 border-0 border-b bg-transparent px-0 py-0 text-right tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </label>
                <span className="text-deep-fern mt-4 block text-right normal-case">
                  {customCoefficient === null ? "—" : `${fmt(customCoefficient, 2)}%`}
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="text-body-sm tracking-body-sm">
            {rows.map((row, i) => (
              <tr
                key={row.key}
                className="border-phosphor-blue-black border-b last:border-0"
              >
                <td
                  className={`py-12 pr-16 pl-20 ${
                    row.key === "no-focus"
                      ? "text-sage-40"
                      : i === 0
                        ? "text-lime-pulse"
                        : "text-phosphor-white"
                  }`}
                >
                  {row.label}
                </td>
                {row.cells.map((cell, j) => (
                  <Cell
                    key={j}
                    metric={metric}
                    cell={cell}
                    itemCost={model.itemCost}
                    muted={row.key === "no-focus"}
                    custom={j === row.cells.length - 1}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {metric === "profit" && (
        <p className="border-phosphor-blue-black text-body-sm tracking-body-sm text-sage-40 border-t px-20 py-12">
          Profit against the item&apos;s last captured price. A figure just above -100% is
          a real result, not a missing one — it means the runes are worth almost nothing
          next to what the item sells for. Cells with no rune price say so instead.
        </p>
      )}
    </section>
  );
}

function Cell({
  metric,
  cell,
  itemCost,
  muted,
  custom,
}: {
  metric: Metric;
  cell: { runes: number; value: number | null } | null;
  itemCost: number | null;
  muted: boolean;
  custom: boolean;
}) {
  // One padding string rather than a base plus an override: two competing
  // pl-* utilities in the same class list are settled by stylesheet order, not
  // by the order they are written here, so the override may lose.
  const box = custom ? "py-12 pr-20 pl-20" : "py-12 pr-16 pl-16";
  const edge = custom ? "border-phosphor-blue-black border-l" : "";
  const tone = muted ? "text-sage-40" : "text-moss-80";

  // No x typed yet: the column exists but has nothing to show.
  if (cell === null) {
    return <td className={`text-deep-fern ${box} text-right ${edge}`}>—</td>;
  }

  if (metric === "runes") {
    return (
      <td className={`${box} text-right tabular-nums ${tone} ${edge}`}>
        {fmt(cell.runes, 1)}
      </td>
    );
  }

  // Missing is spelled out rather than shown as a dash or a zero: an unknown
  // price is not a price of nothing, and a reader should not have to guess
  // which a blank cell meant.
  if (cell.value === null) {
    return (
      <td
        className={`text-deep-fern text-caption ${box} text-right ${edge}`}
        title="No market price captured for this rune yet"
      >
        no price
      </td>
    );
  }

  if (metric === "value") {
    return (
      <td className={`${box} text-right tabular-nums ${tone} ${edge}`}>
        {Math.round(cell.value).toLocaleString("fr-FR")}
      </td>
    );
  }

  const profit = itemCost === null ? null : profitPercent(cell.value, itemCost);
  if (profit === null) {
    return (
      <td
        className={`text-deep-fern text-caption ${box} text-right ${edge}`}
        title="No market price captured for this item, so profit cannot be computed"
      >
        no item price
      </td>
    );
  }
  return (
    <td
      className={`${box} text-right tabular-nums ${edge} ${
        profit >= 0 ? "text-lime-pulse" : "text-sage-40"
      }`}
    >
      {formatProfit(profit)}
    </td>
  );
}
