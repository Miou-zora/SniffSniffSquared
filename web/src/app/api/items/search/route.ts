import { fetchItems } from "@/lib/breaker";
import { query } from "@/lib/db";
import { marksOf, type Status } from "@/lib/verdict";

export const dynamic = "force-dynamic";

export interface ItemHit {
  itemId: number;
  name: string;
  level: number | null;
  type: string | null;
  /** DofusDB icon id — a name is easy to mistake, the picture is not. */
  iconId: number | null;
  /** True when the wire has seen this id — those are the ones with real data. */
  known: boolean;
  /** Your verdict, when you have recorded one. */
  mark: Status | null;
}

/**
 * Item search for the breaker's item picker.
 *
 * Two sources, in this order, because they answer different halves of the
 * question. `items` holds every id the wire has ever produced, so anything you
 * have owned, broken or priced is there and comes back first — that is what a
 * search for "the belt I broke last week" is actually looking for. DofusDB
 * covers the rest of the game, for judging an item you have never held.
 *
 * Local hits are marked `known`, so the UI can say which ones have captured
 * data behind them rather than presenting an empty projection as a result.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json({ items: [] });

  const local = await query<{
    item_id: string;
    name_fr: string | null;
    level: number | null;
    type_fr: string | null;
    icon_id: string | null;
  }>(
    `SELECT item_id, name_fr, level, type_fr, icon_id
       FROM items
      WHERE name_fr ILIKE '%' || $1 || '%'
      ORDER BY length(name_fr), name_fr
      LIMIT 8`,
    [q],
  );

  const items: ItemHit[] = local.map((r) => ({
    itemId: Number(r.item_id),
    name: r.name_fr ?? `Item ${r.item_id}`,
    level: r.level,
    type: r.type_fr,
    iconId: r.icon_id === null ? null : Number(r.icon_id),
    known: true,
    mark: null,
  }));

  if (items.length < 8) {
    const seen = new Set(items.map((i) => i.itemId));
    for (const hit of await searchDofusDb(q, 8 - items.length)) {
      if (!seen.has(hit.itemId)) items.push(hit);
    }
  }

  // Rows named before `icon_id` existed have no picture yet. Asking for it
  // caches it back into `items`, so this is one round trip per item ever
  // rather than one per search, and a failure costs the icon, not the result.
  const iconless = items.filter((i) => i.iconId === null).map((i) => i.itemId);
  if (iconless.length > 0) {
    const meta = await fetchItems(iconless);
    for (const item of items) {
      if (item.iconId === null) item.iconId = meta.get(item.itemId)?.iconId ?? null;
    }
  }

  // A verdict you recorded is worth seeing before you click, not after.
  const marks = await marksOf(items.map((i) => i.itemId));
  for (const item of items) item.mark = marks.get(item.itemId) ?? null;

  return Response.json({ items });
}

/**
 * Names from DofusDB. Cached for a day: item names do not move between game
 * patches, and a search box fires a request per keystroke otherwise.
 *
 * Every failure path returns nothing rather than throwing — a search that finds
 * only local results is a worse search, but a search that 500s is a broken one.
 */
async function searchDofusDb(q: string, limit: number): Promise<ItemHit[]> {
  try {
    // Anchored on a word start so "bois" does not drag in every "Amboise".
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const url =
      `https://api.dofusdb.fr/items?$limit=${limit}` +
      `&name.fr[$regex]=${encodeURIComponent(escaped)}&name.fr[$options]=i`;
    const res = await fetch(url, {
      next: { revalidate: 86_400 },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    const out: ItemHit[] = [];
    for (const raw of data) {
      const it = raw as {
        id?: unknown;
        level?: unknown;
        iconId?: unknown;
        name?: { fr?: unknown };
        type?: { name?: { fr?: unknown } };
      };
      const itemId = Number(it.id);
      const name = it.name?.fr;
      if (!Number.isFinite(itemId) || typeof name !== "string") continue;
      const iconId = Number(it.iconId);
      out.push({
        itemId,
        name,
        level: Number.isFinite(Number(it.level)) ? Number(it.level) : null,
        type: typeof it.type?.name?.fr === "string" ? it.type.name.fr : null,
        iconId: Number.isFinite(iconId) && iconId > 0 ? iconId : null,
        known: false,
        mark: null,
      });
    }
    return out;
  } catch {
    return [];
  }
}
