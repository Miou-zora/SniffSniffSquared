"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { RowLink } from "@/app/items/row";
import type { JobOption } from "@/lib/basket";
import { iconUrl } from "@/lib/icon";
import type { OpportunityRow } from "@/lib/opportunities";

const kamas = new Intl.NumberFormat("fr-FR");

function k(v: number | null) {
  return v === null ? "—" : `${kamas.format(Math.round(v))} k`;
}

function pct(v: number | null) {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toLocaleString("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}%`;
}

type Key =
  "name" | "level" | "ingredientCost" | "sellPrice" | "profitPerUnit" | "marginPercent";

const LABELS: Record<Key, string> = {
  name: "item",
  level: "level",
  ingredientCost: "cost",
  sellPrice: "sell price",
  profitPerUnit: "profit/unit",
  marginPercent: "margin",
};

/** A level bound. Empty means unbounded, mirroring the same input on /items. */
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

export function OpportunitiesTable({
  rows,
  jobs,
}: {
  rows: OpportunityRow[];
  jobs: JobOption[];
}) {
  const [sort, setSort] = useState<{ key: Key; dir: "asc" | "desc" }>({
    key: "marginPercent",
    dir: "desc",
  });
  const [job, setJob] = useState<number | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [minLevel, setMinLevel] = useState("1");
  const [maxLevel, setMaxLevel] = useState("200");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const router = useRouter();

  const shown = useMemo(() => {
    const lo = Number.parseInt(from, 10);
    const hi = Number.parseInt(to, 10);
    const filtered = rows.filter((r) => {
      if (job !== "" && r.jobId !== job) return false;
      if (Number.isInteger(lo) && (r.level ?? 0) < lo) return false;
      if (Number.isInteger(hi) && (r.level ?? 0) > hi) return false;
      return true;
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      // Missing values sink whichever way the column points — an unpriced
      // recipe is not the worst deal, it is one the question does not answer.
      if (x === null && y === null) return a.name.localeCompare(b.name, "fr");
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "fr");
      return cmp === 0 ? a.name.localeCompare(b.name, "fr") : cmp * dir;
    });
  }, [rows, sort, job, from, to]);

  const toggle = (key: Key) =>
    setSort((now) => ({
      key,
      dir: now.key === key ? (now.dir === "asc" ? "desc" : "asc") : "desc",
    }));

  const load = async () => {
    if (job === "") return;
    const lo = Number.parseInt(minLevel, 10);
    const hi = Number.parseInt(maxLevel, 10);
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) return;
    setLoading(true);
    setReport(null);
    const res = await fetch("/api/opportunities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: job, minLevel: lo, maxLevel: hi }),
    });
    const body: { found?: number; levels?: [number, number] | null; error?: string } =
      await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) {
      setReport(body.error ?? "that did not work");
      return;
    }
    const found = body.found ?? 0;
    const span = body.levels ? ` · levels ${body.levels[0]}–${body.levels[1]}` : "";
    setReport(
      found === 0 ? "nothing crafted in that range" : `${found} recipe(s) known${span}`,
    );
    router.refresh();
  };

  return (
    <>
      <div className="mt-24 flex flex-wrap items-center gap-8">
        <select
          value={job}
          onChange={(e) => setJob(e.target.value === "" ? "" : Number(e.target.value))}
          className="border-circuit-border focus:border-lime-pulse text-caption tracking-caption text-phosphor-white bg-ground-iron cursor-pointer rounded-lg border px-12 py-8 outline-none"
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

      {job !== "" && (
        <p className="text-caption tracking-caption text-sage-40 mt-12 flex flex-wrap items-center gap-12">
          <span className="flex items-center gap-8">
            from <Bound value={minLevel} onChange={setMinLevel} placeholder="1" />
            to <Bound value={maxLevel} onChange={setMaxLevel} placeholder="200" />
          </span>
          <button
            type="button"
            disabled={loading}
            onClick={load}
            className="border-circuit-border text-lime-pulse hover:border-lime-pulse focus-visible:ring-lime-pulse cursor-pointer rounded-lg border px-12 py-8 uppercase outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "fetching…" : "load this job in this band"}
          </button>
          {report !== null && <span className="text-moss-70">{report}</span>}
        </p>
      )}

      <div className="border-circuit-border mt-16 overflow-x-auto rounded-2xl border">
        <table className="w-full min-w-[900px] border-collapse text-left">
          <thead>
            <tr className="border-phosphor-blue-black text-caption tracking-caption text-deep-fern border-b uppercase">
              <Sortable column="name" sort={sort} onSort={toggle} first />
              <Sortable column="level" sort={sort} onSort={toggle} align="right" />
              <Sortable
                column="ingredientCost"
                sort={sort}
                onSort={toggle}
                align="right"
              />
              <Sortable column="sellPrice" sort={sort} onSort={toggle} align="right" />
              <Sortable
                column="profitPerUnit"
                sort={sort}
                onSort={toggle}
                align="right"
              />
              <Sortable
                column="marginPercent"
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
                      {r.jobName !== null && (
                        <span className="text-deep-fern text-caption block">
                          {r.jobName}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="text-sage-40 py-12 pr-16 text-right tabular-nums">
                  {r.level ?? "—"}
                </td>
                <td className="text-sage-40 py-12 pr-16 text-right tabular-nums">
                  {k(r.ingredientCost)}
                </td>
                <td className="text-sage-40 py-12 pr-16 text-right tabular-nums">
                  {k(r.sellPrice)}
                </td>
                <td
                  className={`py-12 pr-16 text-right tabular-nums ${
                    r.profitPerUnit === null
                      ? "text-deep-fern"
                      : r.profitPerUnit >= 0
                        ? "text-lime-pulse"
                        : "text-sage-40"
                  }`}
                >
                  {k(r.profitPerUnit)}
                </td>
                <td
                  className={`py-12 pr-20 text-right tabular-nums ${
                    r.marginPercent === null
                      ? "text-deep-fern"
                      : r.marginPercent >= 0
                        ? "text-lime-pulse"
                        : "text-sage-40"
                  }`}
                  title={
                    r.marginPercent === null
                      ? "No captured price for the item or one of its ingredients"
                      : undefined
                  }
                >
                  {pct(r.marginPercent)}
                </td>
              </RowLink>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
