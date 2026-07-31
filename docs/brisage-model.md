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

focus_weight = line_weight/2 + (sum of all line_weights)/2

runes        = focus_weight / rune_weight * coefficient / 100

value        = runes * rune_price

profit_ratio = (value * 100 / item_cost - 100) / 100
```

`focus_weight` is the interesting one. Written as it appears in the sheet it is
`H + SUM(H)/2 - H/2`, which is half this line plus half of everything else — the
focus rule: focusing a stat keeps half of its own weight and harvests half the
weight of every other stat on the item.

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

The same check on the focused Anneau Bsène predicts 33.5 Rune Vi against 32
actual. Larger than the rounding seen above, so the focus branch is close but
not confirmed to the same standard; one more focused crush would settle it.

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
