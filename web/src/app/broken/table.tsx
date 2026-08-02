"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";

import { LocalTime } from "@/app/local-time";
import { RowLink } from "@/app/worth/row";
import type { BrokenRow } from "@/lib/broken";
import { iconUrl } from "@/lib/icon";

type Key = "level" | "name" | "crushes" | "coefficient" | "crushedAt";

const LABELS: Record<Key, string> = {
  level: "level",
  name: "item",
  crushes: "broken",
  coefficient: "coefficient",
  crushedAt: "last broken",
};

/** Ascending by level is the default: coverage is read from the bottom up. */
const DEFAULT_DIR: Record<Key, "asc" | "desc"> = {
  level: "asc",
  name: "asc",
  crushes: "desc",
  coefficient: "desc",
  crushedAt: "desc",
};

/**
 * The coverage table: every breakable item, and whether its coefficient has
 * ever been measured.
 *
 * The filter matters more than the sort here. "Not broken yet" is the list you
 * act on — it is what to take to the crusher next — and on a full catalogue it
 * is most of the rows, so it gets a button rather than a scroll.
 */
export function BrokenTable({
  rows,
  jobs,
}: {
  rows: BrokenRow[];
  jobs: { id: number; name: string }[];
}) {
  const [sort, setSort] = useState<{ key: Key; dir: "asc" | "desc" }>({
    key: "level",
    dir: "asc",
  });
  const [show, setShow] = useState<"all" | "unbroken" | "broken">("all");
  const [job, setJob] = useState<number | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const shown = useMemo(() => {
    // A blank bound is no bound, not zero: leaving "to" empty has to mean
    // "everything above `from`" rather than an empty table.
    const lo = Number.parseInt(from, 10);
    const hi = Number.parseInt(to, 10);
    const filtered = rows.filter((r) => {
      if (show === "broken" && r.crushes === 0) return false;
      if (show === "unbroken" && r.crushes > 0) return false;
      if (job !== "" && r.jobId !== job) return false;
      if (Number.isInteger(lo) && (r.level ?? 0) < lo) return false;
      if (Number.isInteger(hi) && (r.level ?? 0) > hi) return false;
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      // Never-broken rows have no coefficient and no date. They sink either
      // way: the column has nothing to say about them, and floating them to
      // the top of an ascending sort would claim it did.
      if (x === null && y === null) return a.name.localeCompare(b.name, "fr");
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "fr");
      return cmp === 0 ? a.name.localeCompare(b.name, "fr") : cmp * dir;
    });
  }, [rows, sort, show, job, from, to]);

  const toggle = (key: Key) =>
    setSort((now) =>
      now.key === key
        ? { key, dir: now.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <>
      <div className="mt-24 flex flex-wrap items-center gap-8">
        {(["all", "unbroken", "broken"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setShow(option)}
            aria-pressed={show === option}
            className={`text-caption tracking-caption focus-visible:ring-lime-pulse cursor-pointer rounded-lg border px-12 py-8 uppercase transition-colors duration-150 outline-none focus-visible:ring-2 ${
              show === option
                ? "border-lime-pulse text-lime-pulse"
                : "border-circuit-border text-sage-40 hover:text-phosphor-white"
            }`}
          >
            {option === "all"
              ? "everything"
              : option === "unbroken"
                ? "not broken yet"
                : "already broken"}
          </button>
        ))}
        <select
          value={job}
          onChange={(e) => setJob(e.target.value === "" ? "" : Number(e.target.value))}
          className="border-circuit-border focus:border-lime-pulse text-caption tracking-caption text-phosphor-white bg-ground-iron ml-8 cursor-pointer rounded-lg border px-12 py-8 outline-none"
        >
          <option value="">every job</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </select>
        <span className="text-caption tracking-caption text-deep-fern flex items-center gap-8">
          level
          <Bound value={from} onChange={setFrom} placeholder="1" />
          to
          <Bound value={to} onChange={setTo} placeholder="200" />
        </span>
        <span className="text-caption tracking-caption text-deep-fern ml-8">
          {shown.length} shown
        </span>
      </div>

      <div className="border-circuit-border mt-16 overflow-x-auto rounded-2xl border">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
              <Sortable column="name" sort={sort} onSort={toggle} first />
              <Sortable column="level" sort={sort} onSort={toggle} align="right" />
              <Sortable column="crushes" sort={sort} onSort={toggle} align="right" />
              <Sortable column="coefficient" sort={sort} onSort={toggle} align="right" />
              <Sortable
                column="crushedAt"
                sort={sort}
                onSort={toggle}
                align="right"
                last
              />
            </tr>
          </thead>
          <tbody className="text-body-sm tracking-body-sm">
            {shown.map((r) => (
              <RowLink key={r.itemId} href={`/item/${r.itemId}`}>
                <td className="py-12 pr-16 pl-20">
                  <div className="flex items-center gap-12">
                    {r.iconId === null ? (
                      <span aria-hidden className="block h-24 w-24 shrink-0" />
                    ) : (
                      <Image
                        src={iconUrl(r.iconId)}
                        alt=""
                        width={24}
                        height={24}
                        className="shrink-0"
                        unoptimized
                      />
                    )}
                    <div className="min-w-0">
                      <Link
                        href={`/item/${r.itemId}`}
                        className="text-phosphor-white hover:text-lime-pulse"
                      >
                        {r.name}
                      </Link>
                      <span className="text-deep-fern text-caption block">
                        {r.type ?? "—"}
                        {r.held && <span className="text-moss-70"> · held one</span>}
                        {r.mark === "worth" && (
                          <span className="text-lime-pulse"> · worth breaking</span>
                        )}
                      </span>
                    </div>
                  </div>
                </td>
                <td className="text-sage-40 py-12 pr-16 text-right tabular-nums">
                  {r.level ?? "—"}
                </td>
                <td
                  className={`py-12 pr-16 text-right tabular-nums ${
                    r.crushes > 0 ? "text-lime-pulse" : "text-deep-fern"
                  }`}
                  title={
                    r.crushes === 0
                      ? "Never broken — its coefficient is unknown"
                      : `${r.crushes} crush${r.crushes === 1 ? "" : "es"} captured`
                  }
                >
                  {/* The count is the point on a row that has one: a second
                      crush of the same item is a second reading of a rate that
                      moves, and one reading is a sample of one. */}
                  {r.crushes === 0
                    ? "not yet"
                    : `${r.crushes} crush${r.crushes === 1 ? "" : "es"}`}
                </td>
                <td className="text-moss-80 py-12 pr-16 text-right tabular-nums">
                  {r.coefficient === null
                    ? "—"
                    : `${r.coefficient.toLocaleString("fr-FR", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}%`}
                </td>
                <td className="text-deep-fern py-12 pr-20 text-right tabular-nums">
                  {r.crushedAt === null ? "—" : <LocalTime iso={r.crushedAt} withDate />}
                </td>
              </RowLink>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** A level bound. Empty means unbounded, which is why it is not a number 0. */
function Bound({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="number"
      min={1}
      max={200}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      aria-label={`level ${placeholder === "1" ? "from" : "to"}`}
      className="border-circuit-border focus:border-lime-pulse text-caption text-phosphor-white placeholder:text-deep-fern bg-ground-iron w-56 rounded-lg border px-8 py-8 tabular-nums outline-none"
    />
  );
}

function Sortable({
  column,
  sort,
  onSort,
  align,
  first,
  last,
}: {
  column: Key;
  sort: { key: Key; dir: "asc" | "desc" };
  onSort: (key: Key) => void;
  align?: "right";
  first?: boolean;
  last?: boolean;
}) {
  const active = sort.key === column;
  return (
    <th
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`py-12 font-medium ${first ? "pl-20" : ""} ${last ? "pr-20" : "pr-16"} ${
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
        {LABELS[column]}
        <span aria-hidden>{active ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}</span>
      </button>
    </th>
  );
}
