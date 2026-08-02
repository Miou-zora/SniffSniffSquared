"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { LocalTime } from "@/app/local-time";
import { RunePrice } from "@/app/rune-price";
import { RowLink } from "@/app/items/row";
import type { CatalogueRow } from "@/lib/catalogue";
import { iconUrl } from "@/lib/icon";

const kamas = new Intl.NumberFormat("fr-FR");

function k(v: number | null) {
  return v === null ? "—" : `${kamas.format(Math.round(v))} k`;
}

function pct(v: number) {
  return `${v >= 0 ? "+" : ""}${v.toLocaleString("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}%`;
}

type Key =
  "name" | "level" | "crushes" | "coefficient" | "profit" | "focus" | "crushedAt";

const LABELS: Record<Key, string> = {
  name: "item",
  level: "level",
  crushes: "broken",
  coefficient: "coefficient",
  profit: "profit",
  focus: "focus",
  crushedAt: "last broken",
};

const DEFAULT_DIR: Record<Key, "asc" | "desc"> = {
  name: "asc",
  level: "asc",
  crushes: "desc",
  coefficient: "desc",
  profit: "desc",
  focus: "asc",
  crushedAt: "desc",
};

/**
 * Which question the table is being asked. Each one wants its own order, so a
 * chip sets the sort with it: ranking coverage by profit would bury the rows
 * that view exists to show, which are exactly the ones with no profit yet.
 */
type View = "worth" | "unbroken" | "skip" | "all";

const VIEWS: { id: View; label: string; sort: Key }[] = [
  { id: "worth", label: "worth breaking", sort: "profit" },
  { id: "unbroken", label: "not broken yet", sort: "level" },
  { id: "skip", label: "marked skip", sort: "profit" },
  { id: "all", label: "everything", sort: "level" },
];

export function ItemsTable({
  rows,
  jobs,
}: {
  rows: CatalogueRow[];
  jobs: { id: number; name: string }[];
}) {
  const [view, setView] = useState<View>("worth");
  const [sort, setSort] = useState<{ key: Key; dir: "asc" | "desc" }>({
    key: "profit",
    dir: "desc",
  });
  const [job, setJob] = useState<number | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const router = useRouter();

  const shown = useMemo(() => {
    // A blank bound is no bound, not zero: clearing "to" has to widen the list
    // rather than empty it.
    const lo = Number.parseInt(from, 10);
    const hi = Number.parseInt(to, 10);
    const filtered = rows.filter((r) => {
      if (view === "worth" && r.status !== "worth") return false;
      if (view === "skip" && !(r.manual && r.status === "skip")) return false;
      if (view === "unbroken" && r.crushes > 0) return false;
      if (job !== "" && r.jobId !== job) return false;
      if (Number.isInteger(lo) && (r.level ?? 0) < lo) return false;
      if (Number.isInteger(hi) && (r.level ?? 0) > hi) return false;
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      // Missing values sink whichever way the column points. A row with no
      // profit is not the best row and not the worst one; it is one the
      // question does not apply to.
      if (x === null && y === null) return a.name.localeCompare(b.name, "fr");
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "fr");
      return cmp === 0 ? a.name.localeCompare(b.name, "fr") : cmp * dir;
    });
  }, [rows, sort, view, job, from, to]);

  const toggle = (key: Key) =>
    setSort((now) =>
      now.key === key
        ? { key, dir: now.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] },
    );

  const pick = (next: View) => {
    setView(next);
    const preset = VIEWS.find((v) => v.id === next);
    if (preset) setSort({ key: preset.sort, dir: DEFAULT_DIR[preset.sort] });
  };

  return (
    <>
      <div className="mt-24 flex flex-wrap items-center gap-8">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => pick(v.id)}
            aria-pressed={view === v.id}
            className={`text-caption tracking-caption focus-visible:ring-lime-pulse cursor-pointer rounded-lg border px-12 py-8 uppercase transition-colors duration-150 outline-none focus-visible:ring-2 ${
              view === v.id
                ? "border-lime-pulse text-lime-pulse"
                : "border-circuit-border text-sage-40 hover:text-phosphor-white"
            }`}
          >
            {v.label}
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

      {/* The list can only hold what the database knows, and what it knows is
          whatever was browsed, held or imported. Twelve Sculpteur items against
          the 289 the job makes is a sample, not a catalogue — so the page
          offers to go and fetch the rest, once, per job. */}
      {job !== "" && (
        <p className="text-caption tracking-caption text-sage-40 mt-12 flex flex-wrap items-center gap-12">
          <button
            type="button"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              setReport(null);
              const res = await fetch("/api/catalogue", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jobId: job }),
              });
              const body: { recipes?: number; error?: string } = await res
                .json()
                .catch(() => ({}));
              setLoading(false);
              setReport(
                res.ok
                  ? `${body.recipes ?? 0} recipes known for this job`
                  : (body.error ?? "that did not work"),
              );
              router.refresh();
            }}
            className="border-circuit-border text-lime-pulse hover:border-lime-pulse focus-visible:ring-lime-pulse cursor-pointer rounded-lg border px-12 py-8 uppercase outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "fetching…" : "load this job's full catalogue"}
          </button>
          {report === null ? (
            <span>
              Only what has been browsed, held or imported is listed. This asks DofusDB
              for the rest — once; after that it is in the database.
            </span>
          ) : (
            <span className="text-moss-70">{report}</span>
          )}
        </p>
      )}

      <div className="border-circuit-border mt-16 overflow-x-auto rounded-2xl border">
        <table className="w-full min-w-[1100px] border-collapse text-left">
          <thead>
            <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
              <Sortable column="name" sort={sort} onSort={toggle} first />
              <Sortable column="level" sort={sort} onSort={toggle} align="right" />
              <Sortable column="crushes" sort={sort} onSort={toggle} align="right" />
              <Sortable column="coefficient" sort={sort} onSort={toggle} align="right" />
              <Sortable column="focus" sort={sort} onSort={toggle} />
              <th className="py-12 pr-16 text-right font-medium">runes worth</th>
              <th className="py-12 pr-16 text-right font-medium">a copy costs</th>
              <th className="py-12 pr-16 text-right font-medium">to craft</th>
              <Sortable column="profit" sort={sort} onSort={toggle} align="right" />
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
                        {r.jobName !== null && ` · ${r.jobName}`}
                        {r.manual && (
                          <span className="text-moss-70">
                            {" "}
                            · {r.status === "worth" ? "marked worth" : "marked skip"}
                          </span>
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
                <td className="text-moss-80 py-12 pr-16">
                  {r.focus === null ? (
                    r.crushes > 0 ? (
                      "no focus"
                    ) : (
                      "—"
                    )
                  ) : (
                    <RunePrice rune={r.focus} ladder={r.focusLadder} />
                  )}
                </td>
                <td className="text-moss-80 py-12 pr-16 text-right tabular-nums">
                  {k(r.value)}
                </td>
                <td className="text-sage-40 py-12 pr-16 text-right tabular-nums">
                  {k(r.cost)}
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
                  {k(r.craft)}
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
                      ? r.crushes === 0
                        ? "Never broken, so its runes cannot be valued"
                        : "No price captured for a copy, or for one of its runes"
                      : `Against the ${r.against === "craft" ? "craft" : "market"} price`
                  }
                >
                  {r.profit === null ? "—" : pct(r.profit)}
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
        {/* The caret marks only the column in force; one on every heading reads
            as decoration and stops saying anything. */}
        <span aria-hidden>{active ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}</span>
      </button>
    </th>
  );
}
