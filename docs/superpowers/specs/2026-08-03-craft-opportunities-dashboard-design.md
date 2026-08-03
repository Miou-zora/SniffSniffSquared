# Craft opportunities dashboard — design

A new page, `/opportunities`, answering "for this job (métier), which recipes
are profitable to craft and sell on the HDV right now" — restricted to
consumables and resources, since gear's real cost question is already answered
by the breaker/worth pages and gear price comes from individual listings
(`offers`), not the batch ladder this feature is built on.

## Scope

In scope: one new page, one schema column, a handful of pure functions and
queries, all in `web/`. The sniffer is untouched — everything this needs is
already captured (`prices`) or importable from DofusDB (`recipes`, `items`).

Out of scope: equipment profitability (the breaker/worth pages already cover
"is this worth crafting to wear or to break"), HDV sales tax (see below),
automatic buy/sell execution.

## "Hors stuff" — what counts as a candidate

`items.type_id`/`type_fr` name the item's precise type ("Épée", "Chapeau"),
not its category, so neither can drive an equipment/non-equipment split
without an exhaustive and fragile name list. DofusDB exposes a stabler axis:
every item's `type.superTypeId`, one of 26 fixed values (`1` Amulette, `2`
Arme, `6` Consommable, `9` Ressource, `16` Nourriture, `70` Consommables de
combat, ...). Verified directly against the API (`item-super-types`,
`items/<id>`).

- Add `items.super_type_id SMALLINT`, nullable, alongside the existing
  `type_id`/`type_fr`.
- Filled by both current writers of `items`: `tools/import_items.py` (offline)
  and `fetchItems` in `web/src/lib/breaker.ts` (read-side cache-fill) — same
  pattern as every other DofusDB-sourced column on that table.
- The dashboard's candidate filter is a **whitelist**, not a deny-list:
  `super_type_id IN (6, 9, 16, 70)` — Consommable, Ressource, Nourriture,
  Consommables de combat. Everything else (weapons, all wearable slots,
  pets, cosmetics, quest items, ...) is excluded by construction, so a new
  equipment category added to the game costs nothing here — only a new
  *edible/usable* category would need adding to the whitelist.
- Runes fall under Ressource (there is no dedicated Rune super-type) and are
  excluded on top, by `type_fr LIKE 'Rune%'` — the same rule `isBreakableKind`
  (`web/src/lib/kind.ts`) and `IS_EQUIPMENT` (`web/src/lib/broken.ts`) already
  use for the same reason. Keep this exclusion in one place shared by all
  three call sites if practical, since it is one rule that already exists
  twice.

## Job and level filtering

Reuses `jobRecipes(jobId, minLevel, maxLevel)` (`web/src/lib/basket.ts`),
already used by the craft basket's bulk-add for exactly this shape of query.

- The page filters by one job at a time (chips, like `/items`, via
  `craftJobs()`) plus a min/max level range, same defaults and inclusive
  bounds as `addJobRange`.
- **Loading** ("Charger ce métier" button) calls `jobRecipes` with the current
  job and level bounds, then `rememberRecipes` + `fetchItems` — so narrowing
  the band before loading fetches only that slice from DofusDB, not the whole
  job.
- **Displaying** re-applies the same level bounds as a filter over whatever is
  already in `recipes`/`items`, so moving the sliders without reloading still
  narrows the table — it answers "what do I already know about this band"
  before it answers "go get more".

## Profitability

Reuses `planBuy` and the `Ladder` type from `web/src/lib/craft.ts`, and
`latestLadders` from `web/src/lib/breaker.ts` — no new pricing logic for the
buy side.

- **Ingredient cost** for one crafted unit: `planBuy(quantity, ladder)` per
  recipe line (quantity = the recipe's own line quantity, craft count fixed at
  1), summed. `null` as soon as one ingredient has no captured price — a sum
  over the ones that happen to be priced is a wrong number, not a cheaper one
  (same rule as `basket.ts`'s per-entry cost).
- **Sell price**: new pure function in `craft.ts`, `unitPrice(ladder): number
  | null` — the cheapest currently-quoted per-unit rate across b1/b10/b100/
  b1000. This is already computed internally by `offered()` for the buy side;
  extracting it means "what would I have to price at to actually sell" and
  "what's the best deal a buyer sees" are the same number for the same reason
  a market has one price. `null` when the ladder has no quotes at all.
- **Margin**: `margin_pct = (sell - cost) / cost * 100`, `profit_per_unit =
  sell - cost`. Both `null` if either input is `null` — shown as a dash in the
  table, sorted last, never treated as zero or as a loss.
- **No HDV sales tax modeled.** Consistent with the rest of the app — neither
  `worth.ts` nor `brisage.ts` accounts for it today. Flagged as a known gap
  rather than silently assumed; worth reopening if thin-margin recipes turn
  out to be the common case this page surfaces.

## Page

New route `web/src/app/opportunities/`, added to the header nav alongside
Breaker / Items / Craft.

- Job chips (`craftJobs()`) + level min/max inputs, same interaction shape as
  `/items`' job filter and the basket's bulk-add.
- "Charger ce métier" button per the loading behaviour above.
- Table columns: icon, name, level, margin %, profit/unit, ingredient cost,
  sell price, job (only shown in an "all jobs" view, if that view ships —
  otherwise the single selected job makes the column redundant).
- Default sort: margin % descending, unpriced rows last, ties by name.

## Error handling

- A candidate item with no recipe at all (most consumables/resources with no
  craft) is not a row — this page is about *making* something, not about
  every item that exists.
- DofusDB timeout/failure while loading a job degrades to "nothing new
  loaded," never a broken page — same fallback shape used everywhere else this
  API is called (`craftJobs`, `jobRecipes`, `fetchItems`).
- Missing prices (ingredient or sell side) render as a dash, sorted last, and
  are counted so the page can say "N recipes have an unpriced ingredient"
  rather than silently shrinking the list.

## Testing

`unitPrice` and the margin/profit calculation are pure functions with no I/O,
tested the same way `craft.ts`/`brisage.ts` already are — fixed ladders and
recipes in, expected numbers out. No new database or DofusDB mocking needed
for that part; the query/loading layer follows the existing untested-by-design
convention of the rest of `web/src/lib` (server-side composition of already-
tested pure pieces).

## Open question carried into implementation

Whether "all jobs at once" is a real view or the page only ever shows one job
at a time. Not decided here since it does not change any of the above — it is
a small UI variant (one extra chip state, one extra column) rather than a
different data model, and is worth deciding once the single-job view exists
to look at.
