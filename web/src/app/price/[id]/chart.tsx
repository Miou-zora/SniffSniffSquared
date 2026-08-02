"use client";

import { useMemo, useState } from "react";
import {
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { LadderPoint, OfferPoint } from "@/lib/history";

const kamas = new Intl.NumberFormat("fr-FR");

// The design system's own tokens. Recharts takes colours as props, so they are
// named here rather than reached for through a class.
const GRID = "#485346";
const INK = "#8cab87";
const ACCENT = "#7fee64";
const SURFACE = "#181818";

interface Row {
  at: number;
  value: number;
  b1: number | null;
  b10: number | null;
  b100: number | null;
  b1000: number | null;
}

function when(at: number): string {
  return new Date(at).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function short(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

/**
 * One price over time: what a single unit costs.
 *
 * **One series, not four**, and that is the second attempt. Plotting all four
 * batch sizes per unit put them within two pixels of each other — 178, 179.9,
 * 184.0, 182.3 for Rune Vi — so the lines overlapped, their end labels
 * collided, and the chart said "these are all the same" in the least readable
 * way available. The ladder is worth knowing and not worth four lines: the
 * hover reads all four at that moment, and the table under the chart carries
 * every capture in full.
 *
 * x1 is also the number the rest of the app multiplies by, so its drift is the
 * drift under every rune figure on every other page.
 *
 * **The axis covers the data, not zero.** A rune that moved 178 → 169 against
 * an axis anchored at zero is a flat line in the top seventh of the plot, which
 * answers "is this drifting" with "no" whatever it did. A line's slope is the
 * value, where a bar's length is — bars would have to start at zero. The ticks
 * are labelled and the caption says so.
 */
export function PriceChart({
  ladder,
  offers,
}: {
  ladder: LadderPoint[];
  offers: OfferPoint[];
}) {
  const [window, setWindow] = useState<"24h" | "7d" | "all">("all");

  // Measured back from the newest observation, not from the wall clock. The
  // sniffer only sees a price while you browse, so "the last 24 hours" of a
  // capture that stopped last night would be an empty chart — and reading the
  // clock during render is impure besides.
  const cutoff = useMemo(() => {
    if (window === "all") return 0;
    const newest = Math.max(
      ...ladder.map((p) => Date.parse(p.at)),
      ...offers.map((p) => Date.parse(p.at)),
      0,
    );
    return newest - (window === "24h" ? 24 : 24 * 7) * 3_600_000;
  }, [window, ladder, offers]);

  const { rows, label } = useMemo(() => {
    // A stack quote where the market has one, the cheapest listing where it
    // does not. No item has both in practice, and they answer the same question.
    const stacks: Row[] = ladder
      .filter((p) => Date.parse(p.at) >= cutoff && p.b1 > 0)
      .map((p) => ({
        at: Date.parse(p.at),
        value: p.b1,
        b1: p.b1,
        b10: p.b10,
        b100: p.b100,
        b1000: p.b1000,
      }));
    if (stacks.length > 0) return { rows: stacks, label: "x1" };
    const listings: Row[] = offers
      .filter((p) => Date.parse(p.at) >= cutoff)
      .map((p) => ({
        at: Date.parse(p.at),
        value: p.cheapest,
        b1: null,
        b10: null,
        b100: null,
        b1000: null,
      }));
    return { rows: listings, label: "cheapest listing" };
  }, [ladder, offers, cutoff]);

  const domain = useMemo(() => {
    if (rows.length === 0) return [0, 1] as const;
    const values = rows.map((r) => r.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    // A tenth of the range as air, so the line never rides the frame — and a
    // sane band when every capture is identical and the range is zero.
    const pad = range === 0 ? Math.max(1, max * 0.05) : range * 0.1;
    return [Math.max(0, min - pad), max + pad] as const;
  }, [rows]);

  return (
    <>
      <div className="mt-24 flex flex-wrap items-center gap-8">
        {(["24h", "7d", "all"] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWindow(w)}
            aria-pressed={window === w}
            className={`text-caption tracking-caption focus-visible:ring-lime-pulse cursor-pointer rounded-lg border px-12 py-8 uppercase transition-colors duration-150 outline-none focus-visible:ring-2 ${
              window === w
                ? "border-lime-pulse text-lime-pulse"
                : "border-circuit-border text-sage-40 hover:text-phosphor-white"
            }`}
          >
            {w === "all" ? "everything" : `newest ${w}`}
          </button>
        ))}
        {/* One series, so no legend box — this names it. */}
        <span className="text-caption tracking-caption text-deep-fern ml-8">
          {label === "x1" ? "price of one, in kamas" : "cheapest listing, in kamas"} ·{" "}
          {rows.length} capture{rows.length === 1 ? "" : "s"} · the axis covers the range,
          not zero
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="border-circuit-border text-body tracking-body text-sage-40 mt-16 rounded-2xl border px-24 py-20">
          Nothing captured in this window. The sniffer only sees a price when you browse
          that item in the HDV.
        </p>
      ) : (
        // The height sits on the wrapper, not only on the container: Recharts
        // measures the DOM, so it paints nothing until hydration, and a box
        // that grows from zero afterwards is a layout shift on every load.
        <div
          className="border-circuit-border mt-16 rounded-2xl border px-8 py-20"
          style={{ height: 360 }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
              {/* Recessive: hairline, solid, one step off the surface. */}
              <CartesianGrid stroke={GRID} strokeOpacity={0.4} vertical={false} />
              <XAxis
                dataKey="at"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={when}
                stroke={GRID}
                tick={{ fill: INK, fontSize: 11 }}
                minTickGap={48}
              />
              <YAxis
                domain={domain as unknown as [number, number]}
                tickFormatter={short}
                stroke={GRID}
                tick={{ fill: INK, fontSize: 11 }}
                width={56}
              />
              <Tooltip
                cursor={{ stroke: GRID, strokeWidth: 1 }}
                content={<Ladder />}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="value"
                name={label}
                stroke={ACCENT}
                strokeWidth={2}
                // A dot per capture is 56 dots on one line; the hover marker is
                // the one that matters, and it carries a surface ring so it
                // stays legible where it sits on the line.
                dot={false}
                activeDot={{ r: 4, fill: ACCENT, stroke: SURFACE, strokeWidth: 2 }}
                isAnimationActive={false}
              />
              {/* Zoom, which is the one interaction a long capture needs and
                  the window buttons cannot give: an arbitrary span. */}
              {rows.length > 12 && (
                <Brush
                  dataKey="at"
                  height={24}
                  travellerWidth={8}
                  stroke={GRID}
                  fill={SURFACE}
                  tickFormatter={when}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  );
}

/**
 * The whole ladder at the hovered moment, which is why one line is enough on
 * the chart itself. Values lead and labels follow: the reader has the date and
 * wants the number.
 */
function Ladder({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const sizes: [string, number | null][] =
    row.b1 === null
      ? [["cheapest", row.value]]
      : [
          ["x1", row.b1],
          ["x10", row.b10],
          ["x100", row.b100],
          ["x1000", row.b1000],
        ];
  return (
    <div className="border-circuit-border bg-ground-iron text-caption tracking-caption rounded-xl border px-12 py-8">
      <span className="text-deep-fern block uppercase">{when(row.at)}</span>
      {sizes.map(([size, value]) => (
        <span key={size} className="mt-4 flex justify-between gap-16">
          <span
            className={
              value !== null && value > 0
                ? "text-phosphor-white tabular-nums"
                : "text-deep-fern"
            }
          >
            {value !== null && value > 0 ? `${kamas.format(value)} k` : "none on sale"}
          </span>
          <span className="text-sage-40">{size}</span>
        </span>
      ))}
    </div>
  );
}
