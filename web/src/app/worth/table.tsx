"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { LocalTime } from "@/app/local-time";
import { RowLink } from "@/app/worth/row";
import type { WorthRow } from "@/lib/worth";

const kamas = new Intl.NumberFormat("fr-FR");

function pct(v: number) {
  return `${v >= 0 ? "+" : ""}${v.toLocaleString("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}%`;
}

/**
 * Sortable because the list answers more than one question. Ranked by profit it
 * says what to break next; by level it follows what you are actually farming;
 * by focus it groups the items that feed one rune; by when it was crushed it
 * shows which coefficients are old enough to be worth re-reading.
 *
 * Sorted in the browser, not by a round trip: the whole list is already here,
 * and re-running that SQL for a click on a column heading would be a lot of
 * work to arrive at the same rows in a different order.
 */
type Key = "profit" | "level" | "focus" | "crushedAt";

const SORTS: { key: Key; label: string }[] = [
  { key: "profit", label: "profit" },
  { key: "level", label: "level" },
  { key: "focus", label: "focus" },
  { key: "crushedAt", label: "broken" },
];

/** Descending is the useful default for everything but the two labels. */
const DEFAULT_DIR: Record<Key, "asc" | "desc"> = {
  profit: "desc",
  level: "desc",
  focus: "asc",
  crushedAt: "desc",
};

export function WorthTable({ rows }: { rows: WorthRow[] }) {
  const [sort, setSort] = useState<{ key: Key; dir: "asc" | "desc" }>({
    key: "profit",
    dir: "desc",
  });

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      // Missing values sink whichever way the column is pointing: a row with no
      // profit is not the best row, and it is not the worst one either — it is
      // one the question does not apply to.
      if (x === null && y === null) return a.name.localeCompare(b.name, "fr");
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "fr");
      return cmp === 0 ? a.name.localeCompare(b.name, "fr") : cmp * dir;
    });
  }, [rows, sort]);

  const toggle = (key: Key) =>
    setSort((now) =>
      now.key === key
        ? { key, dir: now.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className="border-circuit-border mt-16 overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[900px] border-collapse text-left">
        <thead>
          <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
            <th className="py-12 pr-16 pl-20 font-medium">item</th>
            <Sortable sort={sort} onSort={toggle} column="level" align="right" />
            <Sortable sort={sort} onSort={toggle} column="focus" />
            <th className="py-12 pr-16 text-right font-medium">runes worth</th>
            <th className="py-12 pr-16 text-right font-medium">a copy costs</th>
            <th className="py-12 pr-16 text-right font-medium">to craft</th>
            <Sortable sort={sort} onSort={toggle} column="profit" align="right" />
            <th className="py-12 pr-16 text-right font-medium">coefficient</th>
            <Sortable sort={sort} onSort={toggle} column="crushedAt" align="right" last />
          </tr>
        </thead>
        <tbody className="text-body-sm tracking-body-sm">
          {sorted.map((r) => (
            <RowLink key={r.itemId} href={`/item/${r.itemId}`}>
              <td className="py-12 pr-16 pl-20">
                <Link
                  href={`/item/${r.itemId}`}
                  className="text-phosphor-white hover:text-lime-pulse"
                >
                  {r.name}
                </Link>
                <span className="text-deep-fern text-caption block">
                  {r.type ?? "—"}
                  {r.manual && <span className="text-moss-70"> · marked by you</span>}
                </span>
              </td>
              <td className="text-sage-40 py-12 pr-16 text-right tabular-nums">
                {r.level ?? "—"}
              </td>
              <td className="text-moss-80 py-12 pr-16">{r.focus ?? "no focus"}</td>
              <td className="text-moss-80 py-12 pr-16 text-right tabular-nums">
                {r.value === null ? "—" : `${kamas.format(Math.round(r.value))} k`}
              </td>
              <td className="text-sage-40 py-12 pr-16 text-right tabular-nums">
                {r.cost === null ? "—" : `${kamas.format(Math.round(r.cost))} k`}
              </td>
              <td
                className={`py-12 pr-16 text-right tabular-nums ${
                  r.craft !== null && r.cost !== null && r.craft < r.cost
                    ? "text-moss-80"
                    : "text-sage-40"
                }`}
                title={
                  r.craft === null
                    ? "No recipe, or an ingredient with no captured price"
                    : r.cost !== null && r.craft < r.cost
                      ? "Cheaper to make than to buy"
                      : undefined
                }
              >
                {r.craft === null ? "—" : `${kamas.format(Math.round(r.craft))} k`}
              </td>
              <td
                className={`py-12 pr-16 text-right tabular-nums ${
                  r.profit === null
                    ? "text-deep-fern"
                    : r.profit >= 0
                      ? "text-lime-pulse"
                      : "text-sage-40"
                }`}
                title={
                  r.profit === null
                    ? "No price captured for a copy, or for one of its runes"
                    : undefined
                }
              >
                {r.profit === null ? "no price" : pct(r.profit)}
              </td>
              <td
                className="text-deep-fern py-12 pr-16 text-right tabular-nums"
                title={r.observed ? undefined : "No crush of this item captured"}
              >
                {/* Nothing rather than an assumed 100%: the rate is per item and
                    goes above 100, so a placeholder printed like a reading is a
                    number people would plan around. */}
                {r.observed
                  ? `${r.coefficient.toLocaleString("fr-FR", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}%`
                  : "—"}
              </td>
              <td
                className="text-deep-fern py-12 pr-20 text-right tabular-nums"
                title={r.crushedAt === null ? "Never crushed in a capture" : undefined}
              >
                {r.crushedAt === null ? "—" : <LocalTime iso={r.crushedAt} withDate />}
              </td>
            </RowLink>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sortable({
  column,
  sort,
  onSort,
  align,
  last,
}: {
  column: Key;
  sort: { key: Key; dir: "asc" | "desc" };
  onSort: (key: Key) => void;
  align?: "right";
  last?: boolean;
}) {
  const active = sort.key === column;
  const label = SORTS.find((s) => s.key === column)?.label ?? column;
  return (
    <th
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`py-12 font-medium ${last ? "pr-20" : "pr-16"} ${
        align === "right" ? "text-right" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`hover:text-lime-pulse focus-visible:ring-lime-pulse cursor-pointer rounded-sm uppercase outline-none focus-visible:ring-2 ${
          active ? "text-phosphor-white" : ""
        }`}
      >
        {label}
        {/* The caret only marks the column in force. A caret on every heading
            reads as decoration and stops saying anything. */}
        <span aria-hidden>{active ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}</span>
      </button>
    </th>
  );
}
