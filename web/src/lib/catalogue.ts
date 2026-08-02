/**
 * One list of items, answering both questions that used to have a page each.
 *
 * "What is worth breaking" and "what have I not broken yet" are the same table
 * read with different columns covered up: the first ranks by profit and hides
 * everything below a threshold, the second counts crushes and hides nothing.
 * Splitting them meant you could not sort by profit and see coverage, or filter
 * a job and see which of its items pay — and both pages had to grow the same
 * level column, the same sort, the same job filter, separately.
 *
 * So: the catalogue is the row set, the economics are columns on it, and the
 * chips decide which question is being asked.
 */
import { coverage, type CoverageRow } from "@/lib/broken";
import { judgeItems, type WorthRow } from "@/lib/worth";
import type { RuneLadder } from "@/app/rune-price";
import type { Status } from "@/lib/verdict";

export interface CatalogueRow extends CoverageRow {
  /** Kamas one crush yields, the better of focusing and not. Null when unpriced. */
  value: number | null;
  /** What a copy costs: cheapest listing, else the last stack quote. */
  cost: number | null;
  /** What the ingredients cost, or null with no recipe or an unpriced one. */
  craft: number | null;
  /** Against the cheaper of buying and crafting. Null when neither is known. */
  profit: number | null;
  against: "market" | "craft" | null;
  /** The rune worth focusing, or null when crushing plain wins. */
  focus: string | null;
  focusLadder: RuneLadder | null;
  focusItemId: number | null;
  /** The verdict: your mark, else the threshold under Automatic. */
  status: Status;
  manual: boolean;
}

export interface CatalogueView {
  rows: CatalogueRow[];
  jobs: { id: number; name: string }[];
  /** How many rows have a coefficient from a real crush. */
  measured: number;
  automatic: boolean;
  thresholdPercent: number;
}

export async function catalogueList(): Promise<CatalogueView> {
  const { rows: items, jobs, broken } = await coverage();
  const {
    rows: judged,
    automatic,
    thresholdPercent,
  } = await judgeItems(items.map((r) => r.itemId));

  const economics = new Map<number, WorthRow>(judged.map((r) => [r.itemId, r]));
  const rows: CatalogueRow[] = items.map((item) => {
    const e = economics.get(item.itemId);
    return {
      ...item,
      // The economics query reads the coefficient too, and from the same
      // table. Where it looked harder than the catalogue did — it falls back to
      // the item's own page for rows it cannot value in bulk — its answer wins.
      coefficient: e?.observed ? e.coefficient : item.coefficient,
      value: e?.value ?? null,
      cost: e?.cost ?? null,
      craft: e?.craft ?? null,
      profit: e?.profit ?? null,
      against: e?.against ?? null,
      focus: e?.focus ?? null,
      focusLadder: e?.focusLadder ?? null,
      focusItemId: e?.focusItemId ?? null,
      status: e?.status ?? "skip",
      manual: e?.manual ?? false,
    };
  });

  // A mark on an item the catalogue does not hold still belongs on the list —
  // you put it there, and dropping it would be the page disagreeing with your
  // own opinion.
  const known = new Set(rows.map((r) => r.itemId));
  for (const e of judged) {
    if (known.has(e.itemId) || !e.manual) continue;
    rows.push({
      itemId: e.itemId,
      name: e.name,
      level: e.level,
      type: e.type,
      iconId: null,
      crushes: e.observed ? 1 : 0,
      coefficient: e.observed ? e.coefficient : null,
      crushedAt: e.crushedAt,
      held: false,
      mark: e.manual ? e.status : null,
      jobId: null,
      jobName: null,
      value: e.value,
      cost: e.cost,
      craft: e.craft,
      profit: e.profit,
      against: e.against,
      focus: e.focus,
      focusLadder: e.focusLadder,
      focusItemId: e.focusItemId,
      status: e.status,
      manual: e.manual,
    });
  }

  return { rows, jobs, measured: broken, automatic, thresholdPercent };
}
