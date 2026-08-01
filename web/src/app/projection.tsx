"use client";

import { useMemo, useState, useId } from "react";
import { COEFFICIENT_STEPS, decay, profitPercent, runeCount } from "@/lib/brisage";
import { describePlan } from "@/lib/craft";
import { LocalTime } from "@/app/local-time";
import type { ProjectionModel } from "@/lib/breaker";

type Metric = "runes" | "value" | "profit";
type Basis = "copy" | "average";
type Source = "market" | "manual" | "craft";

const METRICS: { id: Metric; label: string; hint: string }[] = [
  { id: "runes", label: "Runes", hint: "how many runes each focus produces" },
  { id: "value", label: "Kamas", hint: "what those runes sell for" },
  { id: "profit", label: "% vs item", hint: "profit against what the item cost" },
];

/**
 * Where "what the item cost" comes from. They answer different questions and
 * routinely disagree: a crafted item's real cost is its ingredients, which can
 * sit far under what a copy sells for, and the profit line is only honest
 * against the one you actually paid.
 */
const SOURCES: { id: Source; label: string; hint: string }[] = [
  { id: "market", label: "Market", hint: "the item's last captured HDV price" },
  { id: "manual", label: "Manual", hint: "a price you type in" },
  {
    id: "craft",
    label: "Craft",
    hint: "what the ingredients cost, bought in the best batches",
  },
];

/**
 * The two things a stat line can mean, and they are not interchangeable: the
 * copy is what this instance rolled and dies with the crush, the average is
 * what an unowned copy of the type would roll. Deciding whether to buy one to
 * break needs the second; deciding what to do with the one in the slot needs
 * the first.
 */
const BASES: { id: Basis; label: string; hint: string }[] = [
  {
    id: "copy",
    label: "Current item",
    hint: "the stats the item in the breaker actually rolled",
  },
  { id: "average", label: "Average", hint: "what an average copy of this item rolls" },
];

const kamas = new Intl.NumberFormat("fr-FR");

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

export function Projection({
  model,
  itemName,
}: {
  model: ProjectionModel;
  itemName: string;
}) {
  const [metric, setMetric] = useState<Metric>("runes");
  const [basis, setBasis] = useState<Basis>("copy");
  const [customX, setCustomX] = useState("");
  const [source, setSource] = useState<Source>("market");
  const [manualCost, setManualCost] = useState("");
  const [coefficientInput, setCoefficientInput] = useState("");
  const inputId = useId();
  const costId = useId();
  const coeffId = useId();

  // The average basis is absent whenever the template does not cover every
  // line, so a switch left on it would silently fall back. It cannot be
  // selected in that state, and the button says why.
  const active =
    basis === "average" && model.average !== null ? model.average : model.copy;

  const manual = useMemo(() => {
    const v = Number.parseInt(manualCost.replace(/[\s.]/g, ""), 10);
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [manualCost]);

  const craftCost = model.craft?.cost ?? null;
  // What "% vs item" is measured against. Each source can be absent on its own
  // terms — nothing captured, nothing typed, an ingredient with no price — and
  // an absent one disables the metric rather than falling back to another,
  // which would answer a different question than the one selected.
  const itemCost =
    source === "manual" ? manual : source === "craft" ? craftCost : model.itemCost;

  const priced = active.focuses.some((f) => f.unitPrice !== null);
  const canProfit = priced && itemCost !== null;

  // The rate belongs to the item type, so an item never crushed has no observed
  // one. Typing it in is not a preference, it is the only way to get a real
  // answer for an item you have not broken yet — the game shows the figure.
  const typedCoefficient = useMemo(() => {
    const v = Number.parseFloat(coefficientInput.replace(",", "."));
    return Number.isFinite(v) && v > 0 && v <= 100 ? v : null;
  }, [coefficientInput]);
  const coefficient = typedCoefficient ?? model.coefficient;

  const customCoefficient = useMemo(() => {
    const x = Number.parseInt(customX, 10);
    if (!Number.isFinite(x) || x < 1 || x > 100_000) return null;
    return decay(coefficient, x);
  }, [customX, coefficient]);

  const columns = useMemo(
    () => [
      { label: "100%", coefficient: 100 },
      ...COEFFICIENT_STEPS.map((s) => ({
        label: s === 0 ? "n" : `n+${s}`,
        coefficient: decay(coefficient, s),
      })),
    ],
    [coefficient],
  );

  /** Cell values for one row, across the fixed columns plus the custom one. */
  const cellsFor = (
    at: (coefficient: number) => { runes: number; value: number | null },
  ) => [
    ...columns.map((c) => at(c.coefficient)),
    customCoefficient === null ? null : at(customCoefficient),
  ];

  const rows = useMemo(() => {
    const focusRows = active.focuses.map((f) => ({
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
      unpriced: active.noFocusLines.every((l) => l.unitPrice === null),
      cells: cellsFor((coefficient) => {
        let runes = 0;
        let value: number | null = null;
        for (const l of active.noFocusLines) {
          const r = runeCount(l.weight, l.runeWeight, coefficient);
          runes += r;
          if (l.unitPrice !== null) value = (value ?? 0) + r * l.unitPrice;
        }
        return { runes, value };
      }),
    };

    return [...focusRows, noFocus];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, columns, customCoefficient]);

  /**
   * Whether focusing is worth it at all, at the coefficient in force.
   *
   * Focusing concentrates the whole item into one rune, which is not
   * automatically better: crushing with no focus yields every rune the item
   * carries, and their sum can beat the single pile. The table has always shown
   * both and left the arithmetic to the reader.
   *
   * Judged on kamas, because that is the only comparison that means anything —
   * 30 of one rune against 12 of six different ones is not a comparison at all.
   * Column 1 is the current coefficient; column 0 is the 100% ceiling.
   */
  const verdict = useMemo(() => {
    const at = (r: (typeof rows)[number]) => r.cells[1];
    const focuses = rows.filter((r) => r.key !== "no-focus");
    const none = rows.find((r) => r.key === "no-focus");
    if (!none || focuses.length === 0) return null;

    const noneCell = at(none);
    if (!noneCell) return null;
    const priced = noneCell.value !== null && focuses.every((r) => at(r)?.value != null);

    const score = (c: { runes: number; value: number | null } | null) =>
      c === null ? -1 : priced ? (c.value ?? -1) : c.runes;
    const best = focuses.reduce((a, b) => (score(at(b)) > score(at(a)) ? b : a));
    const bestScore = score(at(best));
    const noneScore = score(noneCell);
    if (bestScore <= 0 && noneScore <= 0) return null;

    const focusWins = bestScore >= noneScore;
    const high = Math.max(bestScore, noneScore);
    const low = Math.min(bestScore, noneScore);
    return {
      focusWins,
      priced,
      rune: best.label,
      edge: low > 0 ? (high / low - 1) * 100 : null,
      bestScore,
      noneScore,
    };
  }, [rows]);

  return (
    <section className="border-circuit-border overflow-hidden rounded-2xl border">
      <div className="border-phosphor-blue-black flex flex-wrap items-center gap-x-16 gap-y-12 border-b px-20 py-16">
        <Switch
          label="stats"
          options={BASES.map((b) => ({
            ...b,
            disabled: b.id === "average" && model.average === null,
            reason: "No template ranges for every line — run tools/import_items.py",
          }))}
          value={basis}
          onChange={setBasis}
        />
        <Switch
          label="metric"
          options={METRICS.map((m) => ({
            ...m,
            disabled: (m.id === "value" && !priced) || (m.id === "profit" && !canProfit),
            // Profit needs both sides, and which one is missing decides what to
            // do about it — browse runes, or give the item a price.
            reason:
              m.id === "value" || !priced
                ? "No rune prices captured yet"
                : source === "manual"
                  ? "Type a price for the item"
                  : source === "craft"
                    ? "The craft cost is incomplete"
                    : "No price captured for this item",
          }))}
          value={metric}
          onChange={setMetric}
        />
        <div className="flex basis-full flex-wrap items-center gap-x-16 gap-y-8">
          <span className="text-caption tracking-caption text-deep-fern uppercase">
            item price
          </span>
          <Switch
            label="item price source"
            options={SOURCES.map((s) => ({
              ...s,
              disabled: s.id === "market" && model.itemCost === null,
              reason: "No price captured for this item yet",
            }))}
            value={source}
            onChange={setSource}
          />
          {source === "manual" ? (
            <label
              htmlFor={costId}
              className="text-body-sm tracking-body-sm text-sage-40 flex items-center gap-8"
            >
              <input
                id={costId}
                type="number"
                inputMode="numeric"
                min={1}
                value={manualCost}
                onChange={(e) => setManualCost(e.target.value)}
                placeholder={model.itemCost === null ? "kamas" : String(model.itemCost)}
                aria-label="item price in kamas"
                className="border-circuit-border focus:border-lime-pulse text-body-sm text-phosphor-white placeholder:text-deep-fern w-128 border-0 border-b bg-transparent px-0 py-4 text-right tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              k
            </label>
          ) : (
            <CostReadout source={source} model={model} cost={itemCost} />
          )}
        </div>

        <div className="flex basis-full flex-wrap items-center gap-x-16 gap-y-8">
          <label
            htmlFor={coeffId}
            className="text-caption tracking-caption text-deep-fern uppercase"
          >
            coefficient n
          </label>
          <span className="text-body-sm tracking-body-sm text-sage-40 flex items-center gap-4">
            <input
              id={coeffId}
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={0.01}
              value={coefficientInput}
              onChange={(e) => setCoefficientInput(e.target.value)}
              placeholder={fmt(model.coefficient, 2)}
              aria-label="coefficient percentage"
              className="border-circuit-border focus:border-lime-pulse text-body-sm text-phosphor-white placeholder:text-deep-fern w-64 border-0 border-b bg-transparent px-0 py-4 text-right tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            %
          </span>
          <CoefficientNote
            model={model}
            typed={typedCoefficient !== null}
            itemName={itemName}
          />
        </div>

        {/* Always its own row. It used to sit beside the switches above xl and
            wrap under them below it, so a sentence that grows — Kamas or % vs
            item under Average — jumped from one place to the other, which reads
            as the switch having moved the caption. Same line every time, and it
            gets the width to stay one line. */}
        <p className="text-body-sm tracking-body-sm text-sage-40 basis-full">
          {METRICS.find((m) => m.id === metric)?.hint}, as the coefficient decays
          {basis === "average" && model.average !== null && ", for an average copy"}.
        </p>
      </div>

      {verdict !== null && (
        <p className="border-phosphor-blue-black text-body-sm tracking-body-sm text-sage-40 border-b px-20 py-12">
          {verdict.focusWins ? (
            <>
              <span className="text-lime-pulse font-medium">Focus {verdict.rune}</span>
              {verdict.edge !== null && (
                <> — worth {fmt(verdict.edge, 0)}% more than crushing it with no focus</>
              )}
            </>
          ) : (
            <>
              <span className="text-lime-pulse font-medium">Do not focus</span> — the
              whole item is worth {verdict.edge !== null && `${fmt(verdict.edge, 0)}% `}
              more than focusing {verdict.rune}, the best single rune
            </>
          )}
          {verdict.priced ? (
            <span className="text-deep-fern">
              {" "}
              · in kamas, at {fmt(columns[1]?.coefficient ?? 0, 2)}%
            </span>
          ) : (
            <span className="text-deep-fern">
              {" "}
              · by rune count, which compares different runes — browse their prices to
              judge it in kamas
            </span>
          )}
        </p>
      )}

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
                    itemCost={itemCost}
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

/**
 * Where the coefficient came from, which is the difference between a figure and
 * a guess.
 *
 * The rate belongs to the item type: two capes crushed a minute apart came out
 * at 88.06% and 87.60%, a hat at 17.95%. So a crush of anything else says
 * nothing about this item, and 100% with no crush behind it is a placeholder
 * that happens to be a plausible-looking number.
 */
function CoefficientNote({
  model,
  typed,
  itemName,
}: {
  model: ProjectionModel;
  typed: boolean;
  itemName: string;
}) {
  const base = "text-body-sm tracking-body-sm";
  if (typed) {
    return <p className={`${base} text-sage-40`}>yours, overriding what was captured</p>;
  }
  if (model.coefficientAssumed) {
    return (
      <p className={`${base} text-sage-40`}>
        <span className="text-phosphor-white">assumed</span> — no crush of {itemName} has
        been captured, and the rate is per item, so nothing else stands in for it. Type
        the figure the game shows, or crush one with the sniffer running.
      </p>
    );
  }
  const seen = model.coefficientSeenAt;
  return (
    <p className={`${base} text-sage-40`}>
      from the last crush of {itemName}
      {seen !== null && (
        <>
          {" at "}
          <LocalTime iso={seen} />
        </>
      )}
    </p>
  );
}

/**
 * What the selected source says the item cost, and when it says nothing, why.
 *
 * The craft line names the ingredients it could not price rather than reporting
 * a total over the rest: a partial craft cost is not a cheaper craft, and it
 * would be the most attractive number on the page.
 */
function CostReadout({
  source,
  model,
  cost,
}: {
  source: Source;
  model: ProjectionModel;
  cost: number | null;
}) {
  const base = "text-body-sm tracking-body-sm";

  if (source === "market") {
    return (
      <p className={`${base} text-sage-40`}>
        {cost === null ? (
          "nothing captured for this item yet"
        ) : (
          <>
            <span className="text-phosphor-white tabular-nums">{kamas.format(cost)}</span>{" "}
            k,{" "}
            {model.offerCount > 1
              ? `cheapest of ${model.offerCount} listings`
              : model.offerCount === 1
                ? "the only listing seen"
                : "last quoted on the market"}
          </>
        )}
      </p>
    );
  }

  const craft = model.craft;
  if (craft === null) {
    return (
      <p className={`${base} text-sage-40`}>
        no recipe for this item — most items have none, and DofusDB was asked directly
      </p>
    );
  }

  const via =
    craft.source === "dofusdb" ? (
      <span
        className="text-deep-fern"
        title="Fetched from DofusDB — the importer has not seen this item yet"
      >
        {" "}
        · via DofusDB
      </span>
    ) : null;

  const unpriced = craft.ingredients.filter((i) => i.plan === null);
  if (craft.cost === null) {
    return (
      <p className={`${base} text-sage-40`}>
        <span className="text-phosphor-white">invalid</span> — nothing captured for{" "}
        {unpriced.map((i) => i.name).join(", ")}. Open this item&apos;s craft panel in
        game — the client prices every ingredient and the sniffer stores them.
        {via}
      </p>
    );
  }

  return (
    <p className={`${base} text-sage-40`}>
      <span className="text-phosphor-white tabular-nums">{kamas.format(craft.cost)}</span>{" "}
      k for{" "}
      {craft.ingredients.map((i, n) => (
        <span key={i.itemId}>
          {n > 0 && ", "}
          {i.quantity}x {i.name}
          <span
            className="text-deep-fern"
            title={
              i.plan
                ? `${describePlan(i.plan)} = ${kamas.format(i.plan.cost)} k for ${i.plan.units} units, ${i.plan.rule === "mixed" ? "filled from the largest batch down" : "one batch size for the lot, it prices better"}`
                : undefined
            }
          >
            {" "}
            ({i.plan ? describePlan(i.plan) : "—"})
          </span>
        </span>
      ))}
      {via}
    </p>
  );
}

/**
 * A segmented control. Every state has the same box: padding and weight never
 * change between active and idle, only the colours — a font weight carried by
 * the active button alone reflows the whole group on every click, which reads
 * as the switch being broken.
 */
function Switch<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string; hint: string; disabled?: boolean; reason?: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="border-circuit-border bg-ground-iron flex rounded-xl border p-4"
    >
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            // aria-disabled rather than disabled: a disabled button swallows
            // pointer events, so the title saying *why* it is off would never
            // appear — which is the one moment it is worth reading.
            aria-disabled={o.disabled || undefined}
            aria-pressed={active}
            onClick={() => !o.disabled && onChange(o.id)}
            title={o.disabled ? o.reason : o.hint}
            className={`text-body-sm tracking-body-sm focus-visible:ring-lime-pulse rounded-lg px-16 py-12 font-medium transition-colors duration-150 outline-none focus-visible:ring-2 ${
              active
                ? "bg-lime-pulse text-void-black"
                : o.disabled
                  ? "text-deep-fern cursor-not-allowed"
                  : "text-sage-60 hover:bg-carbon-veil hover:text-phosphor-white cursor-pointer"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
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
