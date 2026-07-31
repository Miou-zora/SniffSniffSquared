# The brisage profitability model

Read out of `Book 3.xlsx` (kept at the repo root). This is the maths for
deciding whether crushing an item into runes makes or loses kamas, and which
rune to focus.

Nothing implements it yet, but the formulas are **verified against a real
crush** (see below) and the reference data is loadable into Postgres with
`tools/import_runes.py`. The point of this document is that the spreadsheet does
not have to be reverse-engineered twice.

## The idea

Crushing an item converts its stats into runes. How many runes depends on the
item's level, the stat values, a per-rune weight, and a **coefficient** that the
game rolls per crush. Focusing a stat converts part of every *other* stat's
weight into that one rune.

So profit is: value of the runes you get, minus what the item cost.

## Sheets

| sheet | role |
|---|---|
| `Feuil1` | inputs and the rune reference table |
| `Coeff` | how the coefficient decays as you keep crafting |
| `Qte` | how many runes each stat yields, per coefficient |
| `Value` | `Qte` x rune price |
| `PercentDiff` | `Value` vs the item's cost — the profitability answer |
| `PrixU` | the same rune table sorted by price per weight |
| `ItemWorth` | a hand-kept list of items: cost, sale value, margin |

`Qte`, `Value` and `PercentDiff` share columns A–I and differ only from column J
onward, each one column per coefficient step.

## Inputs (`Feuil1`)

| cell | meaning |
|---|---|
| `B2` | item level |
| `C2` | what the item cost to obtain ("valeur d'obtention minimum") |
| `D2` | the current coefficient, as a percentage |
| `F:J` | the rune table — stat name, rune name, rune weight, stat per rune, rune price |
| `L` | the item's actual stat values, one row per stat it carries |

The example item in the file: level 79, cost 11 000, coefficient 14, carrying
Chance 30, Dommage 4.5, Intelligence 30, PA 1.

## The formulas

Per stat line, with `level` = `Feuil1!B2`:

```
line_weight  = 3 * stat_value * rune_weight / stat_per_rune * level / 200 + 1

focus_weight = line_weight/2 + (sum of all line_weights)/2

runes        = focus_weight / rune_weight * coefficient / 100

value        = runes * rune_price

profit_ratio = (value * 100 / item_cost - 100) / 100
```

**The `+ 1` on `line_weight` is load-bearing** and easy to miss — it is the last
term of `Value!H2`, after the level division. Every stat line gets a flat +1 on
top of its weight, regardless of the stat. Drop it and the focus branch comes
out consistently low by `(number_of_lines + 1) / 2`, which across real items is
2 to 3.5 — close enough to a constant to look like a missing constant rather
than a missing per-line term. That mistake cost a session.

`focus_weight` is `H + SUM(H)/2 - H/2` in the sheet, which simplifies to
`line_weight/2 + SUM/2` — half this line plus half of everything else. Verified
against five real focused crushes; see
[the focus branch](#the-focus-branch-verified) below.

Without focus this does not apply at all — each line yields its own rune from
`line_weight` directly, and `focus_weight` never enters.

Each column of `Qte`/`Value`/`PercentDiff` recomputes this for one coefficient,
so you can read profitability across a whole crafting run rather than a single
crush.

## Coefficient decay (`Coeff`)

The coefficient drops slightly with every rune produced:

```
next = -(2.63e-5 - 5.958e-10 * n) * n^2 + n
```

At n = 14 the step is about -0.005 per rune, so it decays slowly and
non-linearly. Columns run `n+1`, `n+2`, `n+3`, `n+10`, `n+100`, `n+1000` so a
long session can be projected. Column A is a "Custom" override, set to 100.

## Rune reference

50 runes, exported to [`brisage-runes.json`](brisage-runes.json):

```json
{ "stat_fr": "Vitalité", "rune": "Vi", "rune_weight": 1, "stat_per_rune": 5 }
```

`rune_weight` and `stat_per_rune` are game constants, so they belong in a file.
**Prices are deliberately not here**: the sheet carried a market snapshot that
goes stale, and current prices are what the sniffer's `prices` table is for.

`tools/import_runes.py` loads this into Postgres and adds the DofusDB ids — see
below.

Weights range 1 (Vitalité) to 100; most stats give 1 point per rune, while
Vitalité gives 5.

## What is needed to run this against captured data

The sniffer already supplies most of it:

| the model needs | where it comes from |
|---|---|
| an *unseen* copy's expected stats | the `item_effects` template ranges, averaged by the `item_break_weight` view |
| item level | the `items` table, filled by `tools/import_items.py` |
| item's stat values | the `item_stats` table, written live from `item_detail` |
| coefficient | **already captured** — `crushes.yield_percent` |
| rune prices | **already captured** — the `prices` table |
| rune weights | the `runes` table, loaded by `tools/import_runes.py` |
| item cost | the `prices` table, or `ItemWorth` by hand |

`item_detail` decodes to `{effect_id, value}` pairs — the Anneau Bsène in the
capture carries effect 125 (Vitalité) at 28, plus five more. These are stored in
`item_stats`, keyed by instance uid, because they are per-instance rolls and the
instance does not survive the crush.

**The effect id to rune mapping is built by `tools/import_runes.py`**, which
loads this table into Postgres and resolves each rune against DofusDB:

```sh
docker compose up -d db
tools/import_runes.py            # 50/50 resolved
```

That gives a `runes` table keyed by short name with `item_id` and `effect_id`,
so `item_detail` effects and the focus join straight to a rune weight. The
script is idempotent and has an `--offline` mode that loads weights only.

One caveat carried over: an effect id can cover several runes — 125 is Rune Vi,
Rune Pa Vi and Rune Ra Vi. The table stores the base rune.

## Verified against a real crush

The Arc Anum crush in the capture — level 96, coefficient 32.185%, **no focus**
— predicts against what the game actually returned:

| rune | predicted | actual |
|---|---|---|
| Ine | 23.49 | 23 |
| Age | 19.79 | 20 |
| Ini | 10.75 | 11 |
| Vi | 10.43 | 10 |
| Do Neutre | 2.38 | 2 |
| Do Feu | 2.38 | 2 |
| Ré Per Feu | 1.44 | 2 |
| Ré Per Neutre | 0.98 | 1 |

Every line within ±0.56, which is rounding. **The formulas are correct.**

Note this crush cannot validate the `+ 1` per line: without focus each line is
computed independently, so a flat term shifts every prediction by
`1 / rune_weight * coefficient` — under 0.33 runes here, inside the rounding.
Only the focus branch, where the lines are summed, pins it down.

Two things this pins down:

- with no focus, the quantity uses `line_weight` directly; `focus_weight` is
  only for the focused stat
- the item's stat values come from `item_detail`, its level from DofusDB, and
  the coefficient from `crushes.yield_percent` — the whole input set is
  already captured

### The focus branch: verified

Five focused crushes have been captured. Focus produces **only** the focused
rune — no side runes — so the weight the game used is measurable rather than
inferred:

```
focus_weight = runes_obtained * rune_weight / (coefficient / 100)
```

The rune count is an integer, so each crush pins `focus_weight` to a band of
`+/- 0.5 * rune_weight / (coefficient/100)`, not to a point. A heavy rune or a
low coefficient widens that band, sometimes past usefulness.

| crush | focus | sheet formula | measured band | |
|---|---|---|---|---|
| Couronne du Roi Gelax, 17.95% | Vi | 160.19 | 158.76 - 164.33 | ok |
| Anneau Bsène, 47.85% | Vi | 67.35 | 65.83 - 67.92 | ok |
| Bâton d'Oubli, 76.94% | Vi | 24.44 | 24.04 - 25.34 | ok |
| Kwape de Glace, 87.60% | Invo | 34.63 | 17.12 - 51.37 | ok, band too wide to mean much |
| Cape Maj'Hic, 88.06% | Vi | 10.62 | 10.79 - 11.92 | **0.17 low** |

Four of five land inside their band with no fudge factor. The alternatives are
ruled out: `own + total/2` overshoots the Couronne by 5.6 runes, and
`own/2 + others/2` — excluding the focused line from the sum — is the worst fit
on every sample.

**The Cape Maj'Hic misses by 0.17 weight, or 0.15 runes.** It is also the one
item whose captured stats contradict DofusDB: the wire reports Vi 22, Sagesse 7,
Puissance 2, while the template for item 779 is Vi 31-40, Puissance 7-10 and
three resistances at 2, with no Sagesse and a Vitalité range the captured value
falls below. Its level comes from DofusDB and drives every line weight, so if
the identity is wrong the row is. One additional stat line — contributing
nothing but its `+1` — would move the required offset to `[-0.33, 0.80]` and
close the gap exactly. Not worth chasing further without a second crush on a
cleanly identified item.

### Maluses

The Bâton d'Oubli carries effect 155, `-{n} Intelligence`, value 30, which maps
to no rune. Excluding it entirely — contributing neither weight nor its `+1` —
is what fits. Counting it as a line with weight, in either sign, does not.

## Reading it back out of a capture

```sh
tools/check_brisage.py                # every crush in the database
tools/check_brisage.py --since 8674   # only packets after this id
```

It reconstructs each crush from `packets` alone — the placement, the
`item_detail` for stats, the `crush_request` for the focus and the
`crush_result` for the coefficient and rune counts — then resolves rune weights
from the `runes` table and item levels from DofusDB. No-focus crushes print
predicted against actual per rune; focused crushes print the candidate formulas
against the measured band.

## Caveats

- `Feuil1` column W holds broken `#REF!` formulas, left over from an earlier
  layout. They compute nothing.
- The sheet was last recalculated by LibreOffice, so most formula cells have no
  cached value — the formulas were read directly rather than their results.
- `ItemWorth` is hand-maintained and small (4 rows); its column E mixes formats
  ("96%->83%" as text next to 0.93 as a number).
- **The sheet has a typo.** "Dommage Poussée" is labelled `Do Pi`, the same short
  name as "Dommage Pièges". DofusDB has a distinct Rune Do Pou (item 11649,
  effect 414) for push damage, so `brisage-runes.json` corrects it and records
  the change inline. Left uncorrected it collapses two stats into one.
