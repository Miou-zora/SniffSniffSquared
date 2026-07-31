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

export function Projection({ model }: { model: ProjectionModel }) {
  const [metric, setMetric] = useState<Metric>("runes");
  const [customX, setCustomX] = useState("");
  const inputId = useId();

  const priced = model.focuses.some((f) => f.unitPrice !== null);
  const canProfit = priced && model.itemCost !== null;

  // n, n+1, n+2, ... plus 100% as a ceiling and the user's own n+x.
  const columns = useMemo(() => {
    const base = [
      { label: "100%", coefficient: 100, custom: false },
      ...COEFFICIENT_STEPS.map((s) => ({
        label: s === 0 ? "n" : `n+${s}`,
        coefficient: decay(model.coefficient, s),
        custom: false,
      })),
    ];
    const x = Number.parseInt(customX, 10);
    if (Number.isFinite(x) && x > 0 && x <= 100_000) {
      base.push({
        label: `n+${x}`,
        coefficient: decay(model.coefficient, x),
        custom: true,
      });
    }
    return base;
  }, [model.coefficient, customX]);

  const rows = useMemo(() => {
    const focusRows = model.focuses.map((f) => ({
      key: String(f.effectId),
      label: f.rune,
      unpriced: f.unitPrice === null,
      cells: columns.map((c) => {
        const runes = runeCount(f.focusWeight, f.runeWeight, c.coefficient);
        const value = f.unitPrice === null ? null : runes * f.unitPrice;
        return { runes, value };
      }),
    }));

    const noFocus = {
      key: "no-focus",
      label: "no focus",
      unpriced: model.noFocusLines.every((l) => l.unitPrice === null),
      cells: columns.map((c) => {
        let runes = 0;
        let value: number | null = null;
        for (const l of model.noFocusLines) {
          const r = runeCount(l.weight, l.runeWeight, c.coefficient);
          runes += r;
          if (l.unitPrice !== null) value = (value ?? 0) + r * l.unitPrice;
        }
        return { runes, value };
      }),
    };

    return [...focusRows, noFocus];
  }, [model, columns]);

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-16">
        <div>
          <h2 className="text-heading-sm tracking-heading-sm">Projection</h2>
          <p className="text-body-sm tracking-body-sm text-sage-40 mt-4">
            {METRICS.find((m) => m.id === metric)?.hint}, as the coefficient decays.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-12">
          <div
            role="group"
            aria-label="metric"
            className="border-circuit-border flex rounded-xl border p-4"
          >
            {METRICS.map((m) => {
              const disabled =
                (m.id === "value" && !priced) || (m.id === "profit" && !canProfit);
              const active = metric === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => setMetric(m.id)}
                  title={
                    disabled
                      ? m.id === "value"
                        ? "No rune prices captured yet"
                        : "No price captured for this item"
                      : m.hint
                  }
                  className={`text-body-sm tracking-body-sm rounded-lg px-16 py-8 ${
                    active
                      ? "bg-lime-pulse text-void-black font-medium"
                      : disabled
                        ? "text-deep-fern cursor-not-allowed"
                        : "text-sage-60 hover:text-phosphor-white cursor-pointer"
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <label
            htmlFor={inputId}
            className="text-caption tracking-caption text-deep-fern flex items-center gap-8 uppercase"
          >
            n+
            <input
              id={inputId}
              type="number"
              min={1}
              max={100000}
              value={customX}
              onChange={(e) => setCustomX(e.target.value)}
              placeholder="x"
              className="border-circuit-border text-body-sm text-phosphor-white w-80 rounded-lg border bg-transparent px-12 py-8 text-right normal-case"
            />
          </label>
        </div>
      </div>

      <div className="mt-16 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
              <th className="py-8 pr-16 font-medium">focus</th>
              {columns.map((c) => (
                <th
                  key={c.label + (c.custom ? "-custom" : "")}
                  className="py-8 pl-16 text-right font-medium"
                >
                  <span className={c.custom ? "text-lime-pulse" : "text-moss-70"}>
                    {c.label}
                  </span>
                  <span className="text-deep-fern block normal-case">
                    {fmt(c.coefficient, 2)}%
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-body-sm tracking-body-sm">
            {rows.map((row, i) => (
              <tr key={row.key} className="border-phosphor-blue-black border-b">
                <td
                  className={`py-10 pr-16 ${
                    row.key === "no-focus"
                      ? "text-sage-40"
                      : i === 0
                        ? "text-lime-pulse"
                        : "text-phosphor-white"
                  }`}
                >
                  {row.label}
                  {row.unpriced && metric !== "runes" && (
                    <span className="text-deep-fern"> · no price</span>
                  )}
                </td>
                {row.cells.map((cell, j) => (
                  <Cell
                    key={j}
                    metric={metric}
                    runes={cell.runes}
                    value={cell.value}
                    itemCost={model.itemCost}
                    muted={row.key === "no-focus"}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Cell({
  metric,
  runes,
  value,
  itemCost,
  muted,
}: {
  metric: Metric;
  runes: number;
  value: number | null;
  itemCost: number | null;
  muted: boolean;
}) {
  const tone = muted ? "text-sage-40" : "text-moss-80";

  if (metric === "runes") {
    return (
      <td className={`py-10 pl-16 text-right tabular-nums ${tone}`}>{fmt(runes, 1)}</td>
    );
  }

  // A missing price is not zero. Showing a dash keeps an unknown from being
  // averaged into a total as if the rune were worthless.
  if (value === null) {
    return <td className="text-deep-fern py-10 pl-16 text-right">—</td>;
  }

  if (metric === "value") {
    return (
      <td className={`py-10 pl-16 text-right tabular-nums ${tone}`}>
        {Math.round(value).toLocaleString("fr-FR")}
      </td>
    );
  }

  const profit = itemCost === null ? null : profitPercent(value, itemCost);
  if (profit === null) {
    return <td className="text-deep-fern py-10 pl-16 text-right">—</td>;
  }
  return (
    <td
      className={`py-10 pl-16 text-right tabular-nums ${
        profit >= 0 ? "text-lime-pulse" : "text-sage-40"
      }`}
    >
      {profit >= 0 ? "+" : ""}
      {fmt(profit, 0)}%
    </td>
  );
}
