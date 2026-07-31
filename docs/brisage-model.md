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
line_weight  = 3 * stat_value * rune_weight / stat_per_rune * level / 200

focus_weight = line_weight + (sum of all line_weights)/2

runes        = focus_weight / rune_weight * coefficient / 100

value        = runes * rune_price

profit_ratio = (value * 100 / item_cost - 100) / 100
```

`focus_weight` is the interesting one, and **the formula above is not the
sheet's**. The sheet writes `H + SUM(H)/2 - H/2`, which simplifies to
`line_weight/2 + SUM/2` — half this line plus half of everything else. Measured
against real focused crushes that comes out too low, and the version above,
keeping the focused line in full, is the one that fits. See
[the focus branch](#the-focus-branch-own--total2-on-one-clean-sample) below for
the measurements and for how much confidence it deserves, which is not much:
one clean sample.

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
| item level | DofusDB, via `item_id` |
| item's stat values | **already captured** — `item_detail` carries them |
| coefficient | **already captured** — `crushes.yield_percent` |
| rune prices | **already captured** — the `prices` table |
| rune weights | the `runes` table, loaded by `tools/import_runes.py` |
| item cost | the `prices` table, or `ItemWorth` by hand |

`item_detail` decodes to `{effect_id, value}` pairs — the Anneau Bsène in the
capture carries effect 125 (Vitalité) at 28, plus four more. Only the uid and
type id are currently extracted; the effects are parsed and discarded.

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
| Ine | 23.17 | 23 |
| Age | 19.47 | 20 |
| Ini | 10.43 | 11 |
| Vi | 10.10 | 10 |
| Do Neutre | 2.32 | 2 |
| Do Feu | 2.32 | 2 |
| Ré Per Feu | 1.39 | 2 |
| Ré Per Neutre | 0.93 | 1 |

Every line within ±0.61, which is rounding. **The formulas are correct.**

Two things this pins down:

- with no focus, the quantity uses `line_weight` directly; `focus_weight` is
  only for the focused stat
- the item's stat values come from `item_detail`, its level from DofusDB, and
  the coefficient from `crushes.yield_percent` — the whole input set is
  already captured

### The focus branch: `own + total/2`, on one clean sample

Four focused crushes have been captured. Focus produces **only** the focused
rune — no side runes — so the focus weight the game used can be measured
directly rather than inferred:

```
focus_weight = runes_obtained * rune_weight / (coefficient / 100)
```

The rune count is an integer, so each sample constrains `focus_weight` to a
band of +/- `0.5 * rune_weight / (coefficient/100)` rather than to a point. A
heavy rune or a low coefficient widens that band, sometimes to uselessness.

| crush | own | total | measured focus_weight | band |
|---|---|---|---|---|
| Anneau Bsène, 47.85%, focus Vi | 5.71 | 121.99 | 66.88 | 65.83 - 67.92 |
| Bâton d'Oubli, 76.94%, focus Vi | 1.98 | 42.93 | 24.69 | 24.04 - 25.34 |
| Cape Maj'Hic, 88.06%, focus Vi | 2.24 | 14.99 | 11.36 | 10.79 - 11.92 |
| Kwape de Glace, 87.60%, focus Invo | 18.45 | 45.82 | 34.25 | 17.1 - 51.4 |

Against the candidates:

| crush | `own/2 + total/2` (sheet) | `own/2 + others/2` | **`own + total/2`** |
|---|---|---|---|
| Anneau Bsène | 63.85 ✗ | 61.00 ✗ | **66.71 ✓** |
| Bâton d'Oubli | 22.46 ✗ | 21.47 ✗ | 23.45 ✗ (0.6 low) |
| Cape Maj'Hic | 8.62 ✗ | 7.50 ✗ | 9.74 ✗ (1.1 low) |
| Kwape de Glace | 32.14 ✓ | 22.91 ✓ | 41.36 ✓ (band too wide) |

`own/2 + total/2` is **ruled out**: it misses the Anneau's band by 2.
`own/2 + others/2` — excluding the focused line from the sum — is the worst fit
everywhere and is also ruled out. Note `own + others/2` is not a fourth option;
it is algebraically identical to the sheet's formula, since
`total = own + others`.

**`own + total/2` is adopted on the strength of one clean sample.** It is the
only candidate that fits the Anneau, which is the only crush that is both
tightly constrained and free of modelling defects:

- it is not a weapon, so it carries no damage lines
- every captured effect id matches DofusDB's template for the item exactly
- it carries no malus
- the focused stat is heavy enough (own 5.71) that the candidates are 2.9 apart,
  well outside the 1.05 band

The two misfits each have a specific, identified defect, and both miss *low* —
consistent with weight the model is not counting:

- **The Bâton d'Oubli is a weapon with a malus.** It carries effect 155,
  `-{n} Intelligence`, value 30, which maps to no rune, and effect 98, a weapon
  damage line. Excluding the malus gives 23.45 against a needed 24.04 minimum;
  counting it negatively gives 16.70 and counting its absolute value gives
  30.20, both far worse. So excluding maluses is right and something else is
  missing — plausibly the damage line.
- **Weapon damage lines may contribute to the focus pool.** Effects 98, 99 and
  100 have `characteristic = 0` and yield no rune of their own. The Arc Anum's
  perfect 8/8 fit does **not** clear them: that crush had no focus, and without
  focus each line is computed independently, so `total` never enters the
  arithmetic. Damage lines can only matter under focus, and no focused weapon
  crush is clean enough to test it.
- **The Cape Maj'Hic's identity does not check out.** The wire reports Vi 22,
  Sagesse 7, Puissance 2; DofusDB's template for item 779 is Vi 31-40,
  Puissance 7-10 and three resistances at 2, with no Sagesse at all and a
  Vitalité range the captured value falls below. Four of the five items in the
  capture match their templates exactly, so this one is the anomaly. Its level
  comes from DofusDB and drives every line weight, so if the identity is wrong
  the whole row is. At level 40 rather than 34 it would fit `own + total/2`.

### Settling it

One more focused crush would confirm or break this. To be worth capturing it
should be:

- **not a weapon** — ring, amulet, cape, belt or boots
- **no malus stats** (nothing displayed in red)
- **focused on Vitalité**, or another weight-1 rune. Heavy runes are the trap
  here: the candidates differ by `own/2`, which in *rune* terms is
  `own / (2 * rune_weight)`, and `own` itself scales with the weight — so the
  weight cancels out of the gap while still dividing the rune count. A heavy
  focus like the Kwape's Invocation yields 1 rune and a band 30 wide, which
  distinguishes nothing.
- **high coefficient and a large focused stat value.** The band is
  `+/- 0.5 * rune_weight / (coefficient/100)`; the gap between candidates is
  `own/2`. For a clean read, want `own/2` at least twice the band, so with a
  weight-1 rune at coefficient ~90%, `own > 2.3` — for Vitalité that is
  `stat_value * item_level > 750`.

`tools/check_brisage.py` prints all of this per crush, including which
candidates fall inside the band.

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
