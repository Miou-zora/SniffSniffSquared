# Craft Opportunities Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/opportunities`, a page listing which consumable/resource recipes are profitable to craft and sell on the HDV, filterable by job (métier) and level band.

**Architecture:** A new `items.super_type_id` column (DofusDB category, e.g. Consommable/Ressource) drives a whitelist filter that keeps the dashboard off equipment and runes. Ingredient cost reuses `planBuy`/`latestLadders`; a new `unitPrice` pure function prices the sell side the same way. A new `web/src/lib/opportunities.ts` composes these into rows a client table filters and sorts, matching the existing `/items` page's shape.

**Tech Stack:** TypeScript strict, Next.js 16 Server Components + one client table component, `pg` (no ORM), Python 3 (`tools/import_items.py`, shells out to `psql` via `docker exec`).

## Global Constraints

- TypeScript strict stays on; no new `any`.
- Server Components by default; `"use client"` only where interactivity is needed (the table).
- Database access stays server-side only — never expose `DATABASE_URL` or query logic to the browser.
- `pnpm check` (typecheck + lint + format) must pass before any commit that touches `web/`.
- No new test runner — `web/` has none today. Pure functions are verified manually with `node --experimental-strip-types <script>.mjs` against a relative import of the source file, per the user's explicit choice not to introduce vitest/jest for this feature.
- Candidate items are those with `super_type_id IN (6, 9, 16, 70)` (Consommable, Ressource, Nourriture, Consommables de combat) AND NOT `type_fr LIKE 'Rune%'` — a whitelist, not a deny-list, matching the approved design spec at `docs/superpowers/specs/2026-08-03-craft-opportunities-dashboard-design.md`.
- No HDV sales tax is modeled, consistent with `worth.ts`/`brisage.ts` elsewhere in this app.
- Reuse existing machinery rather than reimplementing it: `planBuy`/`Ladder` (`web/src/lib/craft.ts`), `latestLadders` (`web/src/lib/breaker.ts`), `jobRecipes`/`rememberRecipes`/`craftJobs`/`JobOption` (`web/src/lib/basket.ts`).
- Work happens on the `feature/craft-opportunities-dashboard` branch (already checked out). Commit after every task.

---

### Task 1: `items.super_type_id` schema column

**Files:**
- Modify: `init.sql:199-201`
- Modify: `tools/import_items.py:56-65` (DDL string)

**Interfaces:**
- Produces: `items.super_type_id SMALLINT` (nullable), readable by every later task.

- [ ] **Step 1: Add the column to `init.sql`**

Change:

```sql
-- For databases created before `icon_id` existed. CREATE TABLE IF NOT EXISTS
-- above leaves an existing table alone, columns included.
ALTER TABLE items ADD COLUMN IF NOT EXISTS icon_id BIGINT;
```

to:

```sql
-- For databases created before `icon_id` existed. CREATE TABLE IF NOT EXISTS
-- above leaves an existing table alone, columns included.
ALTER TABLE items ADD COLUMN IF NOT EXISTS icon_id BIGINT;

-- DofusDB's item-super-type id (e.g. 6 = Consommable, 9 = Ressource, 2 = Arme).
-- Coarser and far more stable than type_id/type_fr, which name the precise
-- slot ("Épée") rather than the category — this is what lets a query ask "is
-- this equipment" without an exhaustive, ever-growing name list.
ALTER TABLE items ADD COLUMN IF NOT EXISTS super_type_id SMALLINT;
```

- [ ] **Step 2: Add the same column to the Python tool's DDL**

In `tools/import_items.py`, change:

```python
CREATE TABLE IF NOT EXISTS items (
    item_id    BIGINT PRIMARY KEY,
    name_fr    TEXT,
    level      INT,
    type_id    BIGINT,
    type_fr    TEXT,
    icon_id    BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE items ADD COLUMN IF NOT EXISTS icon_id BIGINT;
```

to:

```python
CREATE TABLE IF NOT EXISTS items (
    item_id    BIGINT PRIMARY KEY,
    name_fr    TEXT,
    level      INT,
    type_id    BIGINT,
    type_fr    TEXT,
    icon_id    BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE items ADD COLUMN IF NOT EXISTS icon_id BIGINT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS super_type_id SMALLINT;
```

- [ ] **Step 3: Verify against a running database**

Run (from repo root, database must be up — `docker compose up -d`):

```bash
docker exec dofus_db psql -U dofus -d dofus -c '\d items'
```

Expected: `super_type_id | smallint` appears in the column list. If the database is not running locally, verify instead that both files parse: `python3 -c "import ast; ast.parse(open('tools/import_items.py').read())"` (expect no output, exit 0) and that `init.sql` has no unbalanced statements by eye — the real check is Step 3's `\d items` the next time the database is up.

- [ ] **Step 4: Commit**

```bash
git add init.sql tools/import_items.py
git commit -m "Add items.super_type_id column for equipment/consumable classification"
```

---

### Task 2: `tools/import_items.py` — fill `super_type_id`

**Files:**
- Modify: `tools/import_items.py:284-310` (`fetch_items`)
- Modify: `tools/import_items.py:371-419` (`enrich`)

**Interfaces:**
- Consumes: `items.super_type_id` column from Task 1.
- Produces: every row `enrich()` writes to `items` now carries `super_type_id`, so DofusDB-imported items are classifiable without a web read-side round trip.

- [ ] **Step 1: Capture `superTypeId` in `fetch_items`**

Change the return-tuple line inside `fetch_items` from:

```python
        for it in r.json().get("data", []):
            t = it.get("type") or {}
            iid = it.get("id")
            found[iid] = (
                (it.get("name") or {}).get("fr"),
                it.get("level"),
                t.get("id"),
                (t.get("name") or {}).get("fr"),
                # Drawn by web/ from https://api.dofusdb.fr/img/items/<id>.png.
                it.get("iconId"),
            )
            ranges[iid] = effect_ranges(it)
    return found, ranges
```

to:

```python
        for it in r.json().get("data", []):
            t = it.get("type") or {}
            iid = it.get("id")
            found[iid] = (
                (it.get("name") or {}).get("fr"),
                it.get("level"),
                t.get("id"),
                (t.get("name") or {}).get("fr"),
                # Drawn by web/ from https://api.dofusdb.fr/img/items/<id>.png.
                it.get("iconId"),
                # DofusDB's item category (6=Consommable, 9=Ressource, 2=Arme,
                # ...). Coarser than type_id/type_fr and what web/'s
                # opportunities dashboard filters equipment out with.
                t.get("superTypeId"),
            )
            ranges[iid] = effect_ranges(it)
    return found, ranges
```

Also update the function's docstring line `"""({item_id: (name, level, type_id, type_name, icon_id)}, ...)"""` to `"""({item_id: (name, level, type_id, type_name, icon_id, super_type_id)}, ...)"""`.

- [ ] **Step 2: Update `enrich()`'s unpacking and INSERT**

Change:

```python
    values = ",\n  ".join(
        "(%d,%s,%s,%s,%s,%s)" % (k, lit(n), lit(lv), lit(ti), lit(tn), lit(ic))
        for k, (n, lv, ti, tn, ic) in sorted(found.items())
    )
    psql(
        "INSERT INTO items (item_id, name_fr, level, type_id, type_fr, icon_id)\nVALUES\n  "
        + values
        + "\nON CONFLICT (item_id) DO UPDATE SET\n"
          "  name_fr = COALESCE(EXCLUDED.name_fr, items.name_fr),\n"
          "  level = COALESCE(EXCLUDED.level, items.level),\n"
          "  type_id = COALESCE(EXCLUDED.type_id, items.type_id),\n"
          "  type_fr = COALESCE(EXCLUDED.type_fr, items.type_fr),\n"
          "  icon_id = COALESCE(EXCLUDED.icon_id, items.icon_id),\n"
          "  updated_at = now();\n"
    )
```

to:

```python
    values = ",\n  ".join(
        "(%d,%s,%s,%s,%s,%s,%s)" % (k, lit(n), lit(lv), lit(ti), lit(tn), lit(ic), lit(sti))
        for k, (n, lv, ti, tn, ic, sti) in sorted(found.items())
    )
    psql(
        "INSERT INTO items (item_id, name_fr, level, type_id, type_fr, icon_id, super_type_id)"
        "\nVALUES\n  "
        + values
        + "\nON CONFLICT (item_id) DO UPDATE SET\n"
          "  name_fr = COALESCE(EXCLUDED.name_fr, items.name_fr),\n"
          "  level = COALESCE(EXCLUDED.level, items.level),\n"
          "  type_id = COALESCE(EXCLUDED.type_id, items.type_id),\n"
          "  type_fr = COALESCE(EXCLUDED.type_fr, items.type_fr),\n"
          "  icon_id = COALESCE(EXCLUDED.icon_id, items.icon_id),\n"
          "  super_type_id = COALESCE(EXCLUDED.super_type_id, items.super_type_id),\n"
          "  updated_at = now();\n"
    )
```

- [ ] **Step 3: Verify**

```bash
python3 -c "import ast; ast.parse(open('tools/import_items.py').read())"
```

Expected: no output, exit code 0 (syntax is valid). If the database is up and the game has been played at least once (so `items` has rows), also run:

```bash
tools/import_items.py --refresh --no-backfill
docker exec dofus_db psql -U dofus -d dofus -c \
  "SELECT item_id, name_fr, super_type_id FROM items WHERE super_type_id IS NOT NULL LIMIT 5;"
```

Expected: at least a few rows with a non-null `super_type_id` (9 for a plain resource like Carapace Verte, item 2609, if that id is in the database).

- [ ] **Step 4: Commit**

```bash
git add tools/import_items.py
git commit -m "Fill items.super_type_id from DofusDB in the offline importer"
```

---

### Task 3: `web/src/lib/breaker.ts` — fill `super_type_id` read-side

**Files:**
- Modify: `web/src/lib/breaker.ts:592-600` (`ItemMeta`)
- Modify: `web/src/lib/breaker.ts:633-681` (`fetchItems`)
- Modify: `web/src/lib/breaker.ts:695-724` (`remember`)

**Interfaces:**
- Consumes: `items.super_type_id` column from Task 1.
- Produces: `ItemMeta.superTypeId: number | null`, and every id `fetchItems` resolves is cached into `items.super_type_id` — the same read-side cache-fill pattern already used for `name`/`level`/`type`/`iconId`. Later tasks (`opportunities.ts`) query `items.super_type_id` directly rather than calling `fetchItems` themselves, but any id the dashboard shows before the offline importer has reached it becomes classifiable the moment any other page (breaker, craft) has looked it up.

- [ ] **Step 1: Add the field to `ItemMeta`**

Change:

```typescript
export interface ItemMeta {
  name: string | null;
  level: number | null;
  type: string | null;
  /** DofusDB icon id — `iconUrl` in src/lib/icon.ts turns it into an image. */
  iconId: number | null;
  /** The template: what each line on this item type can roll between. */
  ranges: { effectId: number; min: number; max: number }[];
}
```

to:

```typescript
export interface ItemMeta {
  name: string | null;
  level: number | null;
  type: string | null;
  /** DofusDB icon id — `iconUrl` in src/lib/icon.ts turns it into an image. */
  iconId: number | null;
  /**
   * DofusDB's item category (e.g. 6 = Consommable, 9 = Ressource, 2 = Arme).
   * Coarser and more stable than `type`, which names the precise slot — this
   * is what the opportunities dashboard filters equipment out with.
   */
  superTypeId: number | null;
  /** The template: what each line on this item type can roll between. */
  ranges: { effectId: number; min: number; max: number }[];
}
```

- [ ] **Step 2: Capture it in `fetchItems`**

Change:

```typescript
        for (const raw of data) {
          const it = raw as {
            id?: unknown;
            level?: unknown;
            iconId?: unknown;
            name?: { fr?: unknown };
            type?: { name?: { fr?: unknown } };
          };
          const id = Number(it.id);
          if (!Number.isFinite(id)) continue;
          const iconId = Number(it.iconId);
          out.set(id, {
            name: typeof it.name?.fr === "string" ? it.name.fr : null,
            level: Number.isFinite(Number(it.level)) ? Number(it.level) : null,
            type: typeof it.type?.name?.fr === "string" ? it.type.name.fr : null,
            iconId: Number.isFinite(iconId) && iconId > 0 ? iconId : null,
            ranges: effectRanges(raw),
          });
        }
```

to:

```typescript
        for (const raw of data) {
          const it = raw as {
            id?: unknown;
            level?: unknown;
            iconId?: unknown;
            name?: { fr?: unknown };
            type?: { name?: { fr?: unknown }; superTypeId?: unknown };
          };
          const id = Number(it.id);
          if (!Number.isFinite(id)) continue;
          const iconId = Number(it.iconId);
          const superTypeId = Number(it.type?.superTypeId);
          out.set(id, {
            name: typeof it.name?.fr === "string" ? it.name.fr : null,
            level: Number.isFinite(Number(it.level)) ? Number(it.level) : null,
            type: typeof it.type?.name?.fr === "string" ? it.type.name.fr : null,
            iconId: Number.isFinite(iconId) && iconId > 0 ? iconId : null,
            superTypeId: Number.isFinite(superTypeId) ? superTypeId : null,
            ranges: effectRanges(raw),
          });
        }
```

- [ ] **Step 3: Persist it in `remember`**

Change:

```typescript
async function remember(meta: Map<number, ItemMeta>): Promise<void> {
  for (const [itemId, m] of meta) {
    try {
      await query(
        `INSERT INTO items (item_id, name_fr, level, type_fr, icon_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (item_id) DO UPDATE SET
           name_fr = COALESCE(EXCLUDED.name_fr, items.name_fr),
           level = COALESCE(EXCLUDED.level, items.level),
           type_fr = COALESCE(EXCLUDED.type_fr, items.type_fr),
           icon_id = COALESCE(EXCLUDED.icon_id, items.icon_id),
           updated_at = now()`,
        [itemId, m.name, m.level, m.type, m.iconId],
      );
```

to:

```typescript
async function remember(meta: Map<number, ItemMeta>): Promise<void> {
  for (const [itemId, m] of meta) {
    try {
      await query(
        `INSERT INTO items (item_id, name_fr, level, type_fr, icon_id, super_type_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (item_id) DO UPDATE SET
           name_fr = COALESCE(EXCLUDED.name_fr, items.name_fr),
           level = COALESCE(EXCLUDED.level, items.level),
           type_fr = COALESCE(EXCLUDED.type_fr, items.type_fr),
           icon_id = COALESCE(EXCLUDED.icon_id, items.icon_id),
           super_type_id = COALESCE(EXCLUDED.super_type_id, items.super_type_id),
           updated_at = now()`,
        [itemId, m.name, m.level, m.type, m.iconId, m.superTypeId],
      );
```

(The rest of `remember`, including the `item_effects` handling below this block, is unchanged.)

- [ ] **Step 4: Verify**

```bash
cd web && pnpm typecheck
```

Expected: no errors. `ItemMeta.superTypeId` is a new required field, so any other place in the codebase constructing an `ItemMeta` literal would now fail to typecheck — this command is what surfaces that; there should be none, since `fetchItems` is the only constructor of `ItemMeta`.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/breaker.ts
git commit -m "Fill items.super_type_id from the web read-side DofusDB cache"
```

---

### Task 4: `unitPrice` and `margin` pure functions

**Files:**
- Modify: `web/src/lib/craft.ts` (add after the `offered` function, before `priceOf`)

**Interfaces:**
- Consumes: `Ladder` (already exported from this file).
- Produces: `unitPrice(ladder: Ladder): number | null` and `margin(cost: number, sell: number): { marginPercent: number; profitPerUnit: number }`, both used by Task 5's `opportunities.ts`.

- [ ] **Step 1: Add `unitPrice`**

Insert after the `offered` function (directly before `function priceOf`):

```typescript
/**
 * The best per-unit rate currently quoted, across whichever batch sizes are on
 * sale — the price you would need to match (or beat) to actually sell one
 * unit, and by the same logic the best deal a buyer already has.
 *
 * Independent of `offered`'s greedy-fill pruning: a seller cares about the
 * single best rate on the ladder, not which sizes are worth mixing to buy.
 */
export function unitPrice(ladder: Ladder): number | null {
  const quoted = [
    { size: 1, price: ladder.b1 },
    { size: 10, price: ladder.b10 },
    { size: 100, price: ladder.b100 },
    { size: 1000, price: ladder.b1000 },
  ].filter((o) => o.price > 0);
  if (quoted.length === 0) return null;
  return Math.min(...quoted.map((o) => o.price / o.size));
}

/** What crafting one unit nets: the sell rate against what it cost to make. */
export interface Margin {
  /** `sell - cost`, in kamas. */
  profitPerUnit: number;
  /** `profitPerUnit / cost * 100`. */
  marginPercent: number;
}

/**
 * Profit and margin for one crafted unit. `cost` must be strictly positive —
 * callers only reach this once both `cost` and `sell` are known prices, never
 * with a null or a zero ingredient cost.
 */
export function margin(cost: number, sell: number): Margin {
  const profitPerUnit = sell - cost;
  return { profitPerUnit, marginPercent: (profitPerUnit / cost) * 100 };
}
```

- [ ] **Step 2: Verify manually — no test runner in this project**

The scratch script must live inside `web/` (not `/tmp`) because it imports
`craft.ts` by a relative path — created and run from `web/`, then deleted:

```bash
cd web
cat > ./scratch-verify.mjs <<'EOF'
import { unitPrice, margin } from "./src/lib/craft.ts";

// b1 unset, b10 quotes 12000 for a batch of 10 -> 1200/unit is the best rate.
console.log("unitPrice:", unitPrice({ b1: 0, b10: 12000, b100: 0, b1000: 0 }));
// Expect 1200.

// All zero -> no quote at all.
console.log("unitPrice (none):", unitPrice({ b1: 0, b10: 0, b100: 0, b1000: 0 }));
// Expect null.

// Cost 800, sells at 1200/unit -> +400 profit, +50% margin.
console.log("margin:", JSON.stringify(margin(800, 1200)));
// Expect {"profitPerUnit":400,"marginPercent":50}.
EOF
node --experimental-strip-types ./scratch-verify.mjs
rm ./scratch-verify.mjs
```

Expected output (a `MODULE_TYPELESS_PACKAGE_JSON` warning on stderr is normal and can be ignored):

```
unitPrice: 1200
unitPrice (none): null
margin: {"profitPerUnit":400,"marginPercent":50}
```

- [ ] **Step 3: Run the project's own checks**

```bash
cd web && pnpm check
```

Expected: passes (typecheck, lint, format all clean).

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/craft.ts
git commit -m "Add unitPrice and margin pure functions to craft.ts"
```

---

### Task 5: `web/src/lib/opportunities.ts` — the data layer

**Files:**
- Create: `web/src/lib/opportunities.ts`

**Interfaces:**
- Consumes: `query` (`@/lib/db`), `planBuy`/`Ladder`/`unitPrice`/`margin` (`@/lib/craft`), `latestLadders` (`@/lib/breaker`), `jobRecipes`/`rememberRecipes`/`craftJobs`/`type JobOption`/`fetchItems` re-exported chain (`@/lib/basket`, `@/lib/breaker`).
- Produces:
  - `interface OpportunityRow { itemId: number; name: string; level: number | null; iconId: number | null; jobId: number; jobName: string | null; ingredientCost: number | null; sellPrice: number | null; profitPerUnit: number | null; marginPercent: number | null; }`
  - `async function loadOpportunities(): Promise<{ rows: OpportunityRow[]; jobs: JobOption[] }>`
  - `async function loadJobLevelBand(jobId: number, minLevel: number, maxLevel: number): Promise<{ found: number; levels: [number, number] | null }>`
  - `const NOT_STUFF_SUPER_TYPES: readonly number[]` (exported for the Task 6 route's error messages if needed, otherwise just used internally)

- [ ] **Step 1: Write the file**

```typescript
/**
 * Which consumable/resource recipes are worth crafting and selling on the
 * HDV, per job (métier).
 *
 * Deliberately excludes equipment: the breaker/worth pages already answer "is
 * this worth crafting to wear or to break," and gear's real price comes from
 * individual listings (`offers`), not the batch ladder this feature reads.
 * Scope and the whitelist below are the approved design at
 * docs/superpowers/specs/2026-08-03-craft-opportunities-dashboard-design.md.
 */
import { craftJobs, jobRecipes, rememberRecipes, type JobOption } from "@/lib/basket";
import { fetchItems, latestLadders } from "@/lib/breaker";
import { margin, planBuy, unitPrice } from "@/lib/craft";
import { query } from "@/lib/db";

/**
 * DofusDB `item.type.superTypeId` values that are NOT equipment: Consommable
 * (6), Ressource (9), Nourriture (16), Consommables de combat (70). A
 * whitelist rather than a deny-list of every weapon/armor slot, so a new
 * equipment category the game adds later costs nothing here — only a new
 * edible/usable category would need adding.
 *
 * Verified against https://api.dofusdb.fr/item-super-types.
 */
const NOT_STUFF_SUPER_TYPES = [6, 9, 16, 70];

/**
 * Runes have no super-type of their own — they fall under Ressource (9) — so
 * they are excluded by name prefix on top of the whitelist above. Same rule as
 * `isBreakableKind` (lib/kind.ts) and `IS_EQUIPMENT` (lib/broken.ts); change
 * all three together if it ever stops being name-based.
 */
const NOT_RUNE_SQL = `NOT COALESCE(i.type_fr LIKE 'Rune%', false)`;

export interface OpportunityRow {
  itemId: number;
  name: string;
  level: number | null;
  iconId: number | null;
  jobId: number;
  jobName: string | null;
  /** Null when an ingredient has no captured price. */
  ingredientCost: number | null;
  /** Null when the item itself has no captured price. */
  sellPrice: number | null;
  /** Null whenever either side above is null. */
  profitPerUnit: number | null;
  marginPercent: number | null;
}

interface RecipeRow extends Record<string, unknown> {
  item_id: string;
  ingredient_id: string;
  quantity: number;
  job_id: number;
  name_fr: string | null;
  level: number | null;
  icon_id: string | null;
}

/**
 * Every candidate recipe already known to the database: a job crafts it, its
 * output passes the not-stuff whitelist, and it is not a rune. Ingredient
 * lines are grouped per item, then priced in one batch pass.
 *
 * Reads only what `recipes`/`items` already hold — it does not call DofusDB.
 * `loadJobLevelBand` below is the action that goes and gets more.
 */
export async function loadOpportunities(): Promise<{
  rows: OpportunityRow[];
  jobs: JobOption[];
}> {
  const [recipeRows, jobs] = await Promise.all([
    query<RecipeRow>(
      `SELECT r.item_id, r.ingredient_id, r.quantity, r.job_id,
              i.name_fr, i.level, i.icon_id
         FROM recipes r
         JOIN items i ON i.item_id = r.item_id
        WHERE r.job_id IS NOT NULL
          AND i.super_type_id = ANY($1::smallint[])
          AND ${NOT_RUNE_SQL}
        ORDER BY r.item_id, r.position`,
      [NOT_STUFF_SUPER_TYPES],
    ),
    craftJobs(),
  ]);

  const jobName = new Map(jobs.map((j) => [j.id, j.name]));

  interface Grouped {
    itemId: number;
    name: string;
    level: number | null;
    iconId: number | null;
    jobId: number;
    lines: { itemId: number; quantity: number }[];
  }
  const grouped = new Map<number, Grouped>();
  for (const r of recipeRows) {
    const itemId = Number(r.item_id);
    const g = grouped.get(itemId) ?? {
      itemId,
      name: r.name_fr ?? `Item ${itemId}`,
      level: r.level,
      iconId: r.icon_id === null ? null : Number(r.icon_id),
      jobId: r.job_id,
      lines: [],
    };
    g.lines.push({ itemId: Number(r.ingredient_id), quantity: r.quantity });
    grouped.set(itemId, g);
  }

  const allIds = new Set<number>();
  for (const g of grouped.values()) {
    allIds.add(g.itemId);
    for (const line of g.lines) allIds.add(line.itemId);
  }
  const ladders = await latestLadders([...allIds]);

  const rows: OpportunityRow[] = [...grouped.values()].map((g) => {
    let ingredientCost: number | null = 0;
    for (const line of g.lines) {
      const ladder = ladders.get(line.itemId);
      const plan = ladder ? planBuy(line.quantity, ladder) : null;
      if (plan === null) {
        ingredientCost = null;
      } else if (ingredientCost !== null) {
        ingredientCost += plan.cost;
      }
    }

    const outputLadder = ladders.get(g.itemId);
    const sellPrice = outputLadder ? unitPrice(outputLadder) : null;

    const m =
      ingredientCost !== null && ingredientCost > 0 && sellPrice !== null
        ? margin(ingredientCost, sellPrice)
        : null;

    return {
      itemId: g.itemId,
      name: g.name,
      level: g.level,
      iconId: g.iconId,
      jobId: g.jobId,
      jobName: jobName.get(g.jobId) ?? null,
      ingredientCost,
      sellPrice,
      profitPerUnit: m?.profitPerUnit ?? null,
      marginPercent: m?.marginPercent ?? null,
    };
  });

  return { rows, jobs };
}

/**
 * Pull one job's recipes in a level band from DofusDB into `recipes`/`items`,
 * same shape as the craft basket's bulk-add (`addJobRange` in basket.ts) but
 * without touching `craft_basket` — this only wants the recipes on the books,
 * not added to a shopping list.
 */
export async function loadJobLevelBand(
  jobId: number,
  minLevel: number,
  maxLevel: number,
): Promise<{ found: number; levels: [number, number] | null }> {
  const recipes = await jobRecipes(jobId, minLevel, maxLevel);
  if (recipes.length === 0) return { found: 0, levels: null };

  await rememberRecipes(recipes);
  // Named now rather than on the next page load, same reasoning as
  // loadJobCatalogue in broken.ts: an id with no name reads as "Item 10181"
  // until something asks DofusDB who it is.
  await fetchItems(recipes.map((r) => r.itemId));

  const levels = recipes.map((r) => r.level).filter((l) => l > 0);
  return {
    found: recipes.length,
    levels: levels.length > 0 ? [Math.min(...levels), Math.max(...levels)] : null,
  };
}
```

- [ ] **Step 2: Verify**

```bash
cd web && pnpm typecheck
```

Expected: no errors. This is a data-only module with no page wired to it yet, so lint may warn about unused exports depending on the ESLint config — if `pnpm lint` flags `loadOpportunities`/`loadJobLevelBand` as unused, that is expected until Task 6/7 import them; do not suppress the warning, just proceed to those tasks next.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/opportunities.ts
git commit -m "Add opportunities.ts: candidate recipes, pricing, job-band loader"
```

---

### Task 6: `POST /api/opportunities` — the "load this job in this band" endpoint

**Files:**
- Create: `web/src/app/api/opportunities/route.ts`

**Interfaces:**
- Consumes: `loadJobLevelBand` (`@/lib/opportunities`).
- Produces: `POST` handler returning `{ ok: true, found: number, levels: [number, number] | null }` or `{ error: string }`, consumed by Task 7's table component via `fetch("/api/opportunities", ...)`.

- [ ] **Step 1: Write the route**

```typescript
import { revalidatePath } from "next/cache";
import { loadJobLevelBand } from "@/lib/opportunities";

/**
 * Pull one job's recipes in one level band from DofusDB, on request.
 *
 * Same reasoning as /api/catalogue: a page that did this on every view would
 * ask DofusDB the same question forever, so it is a button instead.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  const b = body as { jobId?: unknown; minLevel?: unknown; maxLevel?: unknown };
  const jobId = Number(b?.jobId);
  const minLevel = Number(b?.minLevel);
  const maxLevel = Number(b?.maxLevel);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return Response.json({ error: "bad job id" }, { status: 400 });
  }
  if (
    !Number.isInteger(minLevel) ||
    !Number.isInteger(maxLevel) ||
    minLevel < 1 ||
    maxLevel > 200 ||
    minLevel > maxLevel
  ) {
    return Response.json({ error: "bad level range" }, { status: 400 });
  }

  const result = await loadJobLevelBand(jobId, minLevel, maxLevel);
  revalidatePath("/opportunities");
  return Response.json({ ok: true, ...result });
}
```

- [ ] **Step 2: Verify**

```bash
cd web && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/opportunities/route.ts
git commit -m "Add POST /api/opportunities to load a job's level band on demand"
```

---

### Task 7: `/opportunities` page and table

**Files:**
- Create: `web/src/app/opportunities/page.tsx`
- Create: `web/src/app/opportunities/table.tsx`
- Modify: `web/src/app/header.tsx:16-20` (`PAGES`)

**Interfaces:**
- Consumes: `loadOpportunities` (`@/lib/opportunities`), `OpportunityRow`/`JobOption` types, `PageHeader` (`@/app/header`), `RowLink` (`@/app/items/row`), `iconUrl` (`@/lib/icon`).
- Produces: the `/opportunities` route, reachable from the header nav.

- [ ] **Step 1: Write the page**

```typescript
import { PageHeader } from "@/app/header";
import { OpportunitiesTable } from "@/app/opportunities/table";
import { loadOpportunities } from "@/lib/opportunities";

// A price capture or a job load while browsing changes this page; nothing may
// be prerendered.
export const dynamic = "force-dynamic";

/**
 * Which consumable/resource recipes are worth crafting and selling right now,
 * per job. Equipment and runes are out of scope on purpose — see
 * docs/superpowers/specs/2026-08-03-craft-opportunities-dashboard-design.md.
 */
export default async function OpportunitiesPage() {
  const { rows, jobs } = await loadOpportunities();

  return (
    <main className="mx-auto w-full max-w-[1400px] px-24 py-64">
      <PageHeader current="/opportunities" />

      <h1 className="text-heading-lg tracking-heading-lg mt-24">
        {rows.length} recipe{rows.length === 1 ? "" : "s"} known
      </h1>
      <p className="text-body tracking-body text-sage-40 mt-12 max-w-[78ch]">
        Consommables and resources only — equipment and runes are answered by the
        breaker and items pages instead. Cost is the ingredients off the batch
        ladder; sale price is the cheapest rate currently quoted for the item
        itself. No HDV sales tax is factored in.
      </p>

      {rows.length === 0 ? (
        <p className="border-circuit-border text-body tracking-body text-sage-40 mt-32 max-w-[74ch] rounded-xl border px-24 py-20">
          Nothing here yet. Pick a job below and load a level band, or run{" "}
          <span className="text-phosphor-white">tools/import_items.py</span>.
        </p>
      ) : (
        <OpportunitiesTable rows={rows} jobs={jobs} />
      )}
    </main>
  );
}
```

- [ ] **Step 2: Write the table**

```typescript
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

type Key = "name" | "level" | "ingredientCost" | "sellPrice" | "profitPerUnit" | "marginPercent";

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
    setReport(found === 0 ? "nothing crafted in that range" : `${found} recipe(s) known${span}`);
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
              <Sortable column="ingredientCost" sort={sort} onSort={toggle} align="right" />
              <Sortable column="sellPrice" sort={sort} onSort={toggle} align="right" />
              <Sortable column="profitPerUnit" sort={sort} onSort={toggle} align="right" />
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
```

- [ ] **Step 3: Add the nav entry**

In `web/src/app/header.tsx`, change:

```typescript
const PAGES = [
  { href: "/", label: "breaker" },
  { href: "/items", label: "items" },
  { href: "/craft", label: "craft basket" },
] as const;
```

to:

```typescript
const PAGES = [
  { href: "/", label: "breaker" },
  { href: "/items", label: "items" },
  { href: "/craft", label: "craft basket" },
  { href: "/opportunities", label: "opportunities" },
] as const;
```

- [ ] **Step 4: Verify**

```bash
cd web && pnpm check
```

Expected: passes (typecheck, lint, format all clean).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/opportunities web/src/app/header.tsx
git commit -m "Add the /opportunities page, table and nav entry"
```

---

### Task 8: End-to-end manual verification

**Files:** none (verification only).

**Interfaces:** none — this task exercises everything Tasks 1–7 produced together.

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
cd web && pnpm dev
```

- [ ] **Step 2: Load the page cold**

Open `http://localhost:3000/opportunities`. Expected: either the "nothing here yet" message (fresh database) or a table, depending on what `recipes`/`items` already hold.

- [ ] **Step 3: Load a job's level band**

Pick a job with known consumable/resource recipes (e.g. Alchimiste) in the job select, set a level band (e.g. 1–60), click "load this job in this band". Expected: the report line shows a recipe count and a level span, and the table below gains rows for that job after the page refreshes.

- [ ] **Step 4: Check the equipment/rune exclusion**

Pick a job that makes mostly equipment (e.g. Bijoutier) and load the same way. Expected: few or no rows appear even though the job has many recipes — confirms the `super_type_id` whitelist is excluding rings/amulets rather than silently including them.

- [ ] **Step 5: Check sorting and missing-price handling**

Click the "margin" column header twice to flip direction. Expected: rows with a `—` margin (no captured price for the item or an ingredient) stay at the bottom regardless of sort direction, never reading as the worst deal.

- [ ] **Step 6: Final check**

```bash
cd web && pnpm check
```

Expected: passes. Nothing left uncommitted:

```bash
git status --short
```

Expected: empty (everything from Tasks 1–7 already committed).
