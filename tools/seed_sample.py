#!/usr/bin/env python3
"""
Fill the database with a coherent demo dataset, so `web/` can be looked at
without a game client and a capture session.

Two halves, and the split is the whole point:

  reference     REAL, from DofusDB. Item names, levels, types, icons, template
                stat ranges, recipes and the job that crafts them. The same
                data tools/import_items.py writes, from the same endpoint --
                anything a tooltip could tell you is genuine here.

  observations  FABRICATED. Marketplace ladders, individual listings, what one
                copy rolled, crush yields, bag contents. Only the server knows
                these, so the wire is their only real source and nothing below
                came off it.

That line matters because the rest of this repo treats captured observations as
ground truth. A demo database is not a capture: do not point
tools/check_brisage.py at one, and do not read a yield here as evidence about
the model. `packets` is never touched, so a real archive survives a seed.

The numbers are invented but not arbitrary -- prices are derived so the pages
say something. Rune prices scale with `rune_weight`, tuned through the one real
ladder ever captured (Rune Do Air, weight 5, x1 at 1211 kamas). Gear is then
priced *backwards* from what breaking it is worth, at a spread of target
margins, which is what makes the worth ranking on /items a real ordering rather
than noise. Crafted consumables get a sell price drawn around their ingredient
cost, so /opportunities has winners and losers.

Deterministic: every figure is drawn from a generator seeded by the item id, so
a re-run reproduces the same database and a screenshot stays valid.

Usage:
    tools/seed_sample.py                # reference upserted, observations added
    tools/seed_sample.py --reset        # empty the observation tables first,
                                        # which is what a re-run wants: `prices`
                                        # has no unique key, so seeding twice
                                        # doubles the series rather than
                                        # replacing it
    tools/seed_sample.py --dry-run      # report, write nothing

Requires the `db` container running (docker compose up -d db), `requests`, and
a populated `runes` table (tools/import_runes.py).
"""
import argparse
import os
import random
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_items import fetch_items, lit, psql  # noqa: E402

RECIPES_API = "https://api.dofusdb.fr/recipes"

# The catalogue the demo is built from: (job id, min level, max level). Three
# equipment jobs so /items has gear worth ranking, and one consumable job so
# /opportunities has recipes it is allowed to look at -- it excludes equipment
# on purpose.
CATALOGUE = [
    (16, 20, 90),   # Bijoutier   -- amulets, rings
    (15, 20, 90),   # Cordonnier  -- boots, belts, capes
    (11, 20, 90),   # Forgeron    -- weapons; their damage lines map to no rune,
                    #                which is the case the projection has to show
    (26, 1, 100),   # Alchimiste  -- potions, the consumable side
]
MAX_PER_JOB = 55

# Pépite. `web/src/lib/opportunities.ts` reads its ladder out of `prices` to
# value recycling, so it needs a row like any other tradeable resource.
NUGGET_ITEM_ID = 14635

# What reaches your character; the alliance takes the rest. Mirrors
# CHARACTER_SHARE in web/src/lib/recycle.ts, which is where it is explained.
CHARACTER_SHARE = 0.6

# DofusDB serves 50 rows per request whatever $limit asks for.
PAGE = 50

# Observations are dated across this window, ending now, so the price history
# charts have a shape and "measured 3 days ago" means something.
WINDOW_DAYS = 12

# uids for fabricated instances. Real ones off the wire are 40-bit-ish values;
# this range is deliberately far from them so a demo instance is recognisable
# in a database that later sees real traffic.
UID_BASE = 900_000_000_000

# The observation tables this script owns. `items`, `item_effects` and
# `recipes` are upserted rather than listed here: they are reference data, and
# a real importer run writes exactly the same rows.
OWNED = [
    "offer_stats", "offers", "prices", "crush_placements", "crushes",
    "item_stats", "inventory", "craft_basket", "item_marks", "app_settings",
]

NOW = datetime.now(timezone.utc).replace(microsecond=0)


def ts(days_ago, jitter_minutes=0, rnd=None):
    t = NOW - timedelta(days=days_ago)
    if jitter_minutes and rnd:
        t -= timedelta(minutes=rnd.uniform(0, jitter_minutes))
    return t.isoformat()


def gen(*parts):
    """A generator keyed by whatever identifies the thing being invented, so the
    same item draws the same numbers however the run is ordered."""
    return random.Random("|".join(str(p) for p in parts))


# ---- reference: real data from DofusDB --------------------------------------

def job_recipes(job_id, lo, hi, cap):
    """Every recipe a job makes in a level band, paged."""
    import requests

    out, skip = [], 0
    while len(out) < cap:
        params = [
            ("$limit", str(PAGE)), ("$skip", str(skip)), ("jobId", str(job_id)),
            ("resultLevel[$gte]", str(lo)), ("resultLevel[$lte]", str(hi)),
            ("$select[]", "resultId"), ("$select[]", "resultLevel"),
            ("$select[]", "jobId"), ("$select[]", "ingredientIds"),
            ("$select[]", "quantities"),
        ]
        try:
            r = requests.get(RECIPES_API, params=params, timeout=30)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001 -- network is best-effort
            print("  ! DofusDB recipe lookup failed (%s)" % e)
            break
        data = r.json().get("data", [])
        if not data:
            break
        for rec in data:
            iid, ings = rec.get("resultId"), rec.get("ingredientIds") or []
            qtys = rec.get("quantities") or []
            # A mismatched pair is a recipe we cannot read rather than a partial
            # one, and half a recipe prices the item too cheaply.
            if iid is None or not ings or len(ings) != len(qtys):
                continue
            out.append({
                "item_id": int(iid),
                "job_id": int(rec.get("jobId") or job_id),
                "level": int(rec.get("resultLevel") or 0),
                "ingredients": [(p, int(a), int(q))
                                for p, (a, q) in enumerate(zip(ings, qtys))],
            })
        skip += PAGE
    return out[:cap]


def write_reference(recipes, meta, ranges, dry_run):
    """`items`, `item_effects` and `recipes`, in the shape import_items.py
    writes them -- same columns, same replace-wholesale rule."""
    items = sorted(meta)
    if not dry_run and items:
        psql(
            "INSERT INTO items (item_id, name_fr, level, type_id, type_fr,"
            " icon_id, super_type_id, recycle_nuggets)\nVALUES\n  "
            + ",\n  ".join(
                "(%d,%s,%s,%s,%s,%s,%s,%s)" % (
                    iid, lit(meta[iid][0]), lit(meta[iid][1]), lit(meta[iid][2]),
                    lit(meta[iid][3]), lit(meta[iid][4]), lit(meta[iid][5]),
                    lit(meta[iid][6]))
                for iid in items)
            + "\nON CONFLICT (item_id) DO UPDATE SET\n"
              "  name_fr = COALESCE(EXCLUDED.name_fr, items.name_fr),\n"
              "  level = COALESCE(EXCLUDED.level, items.level),\n"
              "  type_id = COALESCE(EXCLUDED.type_id, items.type_id),\n"
              "  type_fr = COALESCE(EXCLUDED.type_fr, items.type_fr),\n"
              "  icon_id = COALESCE(EXCLUDED.icon_id, items.icon_id),\n"
              "  super_type_id = COALESCE(EXCLUDED.super_type_id,"
              " items.super_type_id),\n"
              # NULLIF, not COALESCE alone, and for the reason import_items.py
              # gives: DofusDB serves 0 for every craftable item, so a zero here
              # would clobber whatever tools/extract_nuggets.py decomposed off
              # the client bundles. A demo has no bundles, so craftables simply
              # stay NULL — which reads as "not computed" rather than as "not
              # worth recycling".
              "  recycle_nuggets = COALESCE(NULLIF(EXCLUDED.recycle_nuggets, 0),"
              " items.recycle_nuggets),\n"
              "  updated_at = now();\n")

    # Replaced wholesale: a template that loses a line between game versions has
    # to lose the row rather than keep a stale one.
    with_ranges = {i: r for i, r in ranges.items() if r}
    if not dry_run and with_ranges:
        psql(
            "DELETE FROM item_effects WHERE item_id IN (%s);\n"
            % ",".join(str(i) for i in sorted(with_ranges))
            + "INSERT INTO item_effects"
              " (item_id, position, effect_id, min_value, max_value)\nVALUES\n  "
            + ",\n  ".join(
                "(%d,%d,%d,%d,%d)" % (iid, pos, eid, lo, hi)
                for iid in sorted(with_ranges)
                for pos, eid, lo, hi in with_ranges[iid])
            + ";\n")

    if not dry_run and recipes:
        psql(
            "DELETE FROM recipes WHERE item_id IN (%s);\n"
            % ",".join(str(r["item_id"]) for r in recipes)
            + "INSERT INTO recipes"
              " (item_id, position, ingredient_id, quantity, job_id)\nVALUES\n  "
            + ",\n  ".join(
                "(%d,%d,%d,%d,%d)" % (r["item_id"], pos, ing, qty, r["job_id"])
                for r in recipes for pos, ing, qty in r["ingredients"])
            + ";\n")

    print("  reference: %d item(s), %d template(s), %d recipe(s)"
          % (len(items), len(with_ranges), len(recipes)))


# ---- observations: invented ------------------------------------------------

def rune_unit_price(rune):
    """What one rune fetches, scaled by its weight.

    Anchored on the single real ladder this repo ever captured: Rune Do Air,
    rune_weight 5, x1 at 1211 kamas. 95 * w**1.6 puts that at ~1250 and keeps
    Vitalite cheap and Retrait PA dear, which is the shape of the real market.
    """
    w = rune["rune_weight"]
    base = 95 * (w ** 1.6)
    return max(20, int(base * gen("rune", rune["rune"]).uniform(0.75, 1.35)))


def ladder(unit, rnd):
    """A batch ladder around a per-unit rate.

    Bigger batches are quoted at a small discount, and any size may simply not
    be on sale -- a 0, which every reader treats as absence of a price rather
    than a price of nothing.
    """
    out = []
    for size, discount in ((1, 1.0), (10, 0.97), (100, 0.94), (1000, 0.91)):
        # x1 is always quoted: it is what every rune figure multiplies by, and
        # a missing one would read as an unpriced rune rather than a thin market.
        if size > 1 and rnd.random() < (0.15 if size < 1000 else 0.45):
            out.append(0)
            continue
        out.append(max(1, int(unit * size * discount * rnd.uniform(0.95, 1.06))))
    return out


def walk(unit, rnd, points):
    """A price series that drifts rather than jumping, so a chart has a shape."""
    series, v = [], unit
    for _ in range(points):
        series.append(v)
        v = max(1.0, v * rnd.gauss(1.0, 0.06))
    return series


def break_value(level, ranges, by_effect, rune_price, coefficient):
    """What one crush of an average copy fetches, by docs/brisage-model.md.

    The same arithmetic web/src/lib/worth.ts runs in SQL: the better of
    focusing and not, the trailing +1 on every line included. Lines that map to
    no rune are dropped, which is why a weapon's damage lines contribute
    nothing here either.
    """
    lines = []
    for _pos, eid, lo, hi in ranges:
        r = by_effect.get(eid)
        if r is None:
            continue
        avg = (lo + hi) / 2.0
        lines.append((3 * avg * r["rune_weight"] / r["stat_per_rune"]
                      * level / 200.0 + 1, r))
    if not lines:
        return None
    total = sum(w for w, _ in lines)
    no_focus = sum(w / r["rune_weight"] * coefficient / 100.0
                   * rune_price[r["rune"]] for w, r in lines)
    focused = max((w / 2 + total / 2) / r["rune_weight"] * coefficient / 100.0
                  * rune_price[r["rune"]] for w, r in lines)
    return max(no_focus, focused)


def roll(ranges, rnd):
    """One instance's stat lines, drawn from the item type's template.

    Keyed by effect id because item_stats is: a template that lists the same
    effect twice would otherwise collide on the primary key.
    """
    out = {}
    for _pos, eid, lo, hi in ranges:
        if eid in out:
            continue
        out[eid] = lo if hi <= lo else rnd.randint(lo, hi)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reset", action="store_true",
                    help="empty the observation tables before seeding")
    ap.add_argument("--dry-run", action="store_true", help="report, write nothing")
    args = ap.parse_args()

    runes = psql("SELECT rune, rune_weight, stat_per_rune, item_id, effect_id"
                 " FROM runes WHERE effect_id IS NOT NULL AND item_id IS NOT NULL",
                 rows=True)
    if not runes:
        sys.exit("`runes` is empty -- run tools/import_runes.py first.")
    by_effect = {
        int(e): {"rune": name, "rune_weight": float(w), "stat_per_rune": float(spr),
                 "item_id": int(iid), "effect_id": int(e)}
        for name, w, spr, iid, e in runes
    }
    by_name = {r["rune"]: r for r in by_effect.values()}
    rune_price = {name: rune_unit_price(r) for name, r in by_name.items()}
    print("runes: %d mapped effects, x1 from %d to %d kamas"
          % (len(by_effect), min(rune_price.values()), max(rune_price.values())))

    # --- reference ---------------------------------------------------------
    recipes = []
    for job, lo, hi in CATALOGUE:
        found = job_recipes(job, lo, hi, MAX_PER_JOB)
        print("job %d, levels %d-%d: %d recipe(s)" % (job, lo, hi, len(found)))
        recipes += found

    if not recipes:
        sys.exit("DofusDB returned no recipes -- nothing to build a demo from.")

    ids = {r["item_id"] for r in recipes}
    for r in recipes:
        ids.update(ing for _p, ing, _q in r["ingredients"])
    ids.update(r["item_id"] for r in by_name.values())   # the runes themselves
    ids.add(NUGGET_ITEM_ID)                              # and what recycling pays in
    meta, ranges = fetch_items(sorted(ids))
    print("DofusDB: %d/%d id(s) resolved" % (len(meta), len(ids)))

    # An item DofusDB would not name cannot be shown, priced or ranked, so it is
    # dropped here rather than left to surface as "Item 10181" on every page.
    recipes = [r for r in recipes
               if r["item_id"] in meta
               and all(ing in meta for _p, ing, _q in r["ingredients"])]

    if args.reset and not args.dry_run:
        psql("TRUNCATE %s;\n" % ", ".join(OWNED))
        print("reset: emptied %s" % ", ".join(OWNED))

    write_reference(recipes, meta, ranges, args.dry_run)

    # --- observations ------------------------------------------------------
    def level_of(iid):
        return max(1, int(meta[iid][1] or 1))

    def super_type(iid):
        return meta[iid][5]

    # Equipment is everything the catalogue crafts that is not a consumable or a
    # resource -- the same whitelist web/src/lib/opportunities.ts filters on.
    NOT_STUFF = {6, 9, 16, 70}
    outputs = {r["item_id"] for r in recipes}
    equipment = sorted(i for i in outputs if super_type(i) not in NOT_STUFF)
    consumables = sorted(i for i in outputs if super_type(i) in NOT_STUFF)
    ingredients = sorted({ing for r in recipes for _p, ing, _q in r["ingredients"]})

    # A per-unit rate for everything sold as a stack: runes, ingredients, and the
    # consumables the craft jobs make. Gear is not here -- it sells as individual
    # listings, and `offers` is where that belongs.
    unit = {}
    for name, r in by_name.items():
        unit[r["item_id"]] = rune_price[name]

    # A level-based prior for resources, before the recipes below get a say in
    # what they are actually worth.
    prior = {iid: max(5, int((12 + level_of(iid) * 6.5)
                             * gen("ing", iid).uniform(0.55, 1.9)))
             for iid in ingredients if iid not in unit}

    # Crush coefficients, per item type. Real captures ran from 17.95% to 143%,
    # so the spread is wide on purpose -- and only some items have ever been
    # broken, because "what have I not measured" is the question /items exists
    # to answer.
    coefficient, crushed_at = {}, {}
    for iid in equipment:
        r = gen("crush", iid)
        if r.random() > 0.45:
            continue
        coefficient[iid] = round(max(16.0, min(150.0, r.gauss(86, 30))), 2)
        crushed_at[iid] = r.uniform(0.2, WINDOW_DAYS - 1)

    # Gear priced backwards from what breaking it is worth, at a spread of
    # target margins around the 15% threshold: some items clear it, most do not,
    # and the ranking on /items is then a real ordering instead of noise.
    gear_cost = {}
    for iid in equipment:
        r = gen("gear", iid)
        value = break_value(level_of(iid), ranges.get(iid, []), by_effect,
                            rune_price, coefficient.get(iid, 100.0))
        if value is None or value <= 0:
            # No rune-yielding line: it never reaches the worth list, so its
            # price only has to be plausible for its level.
            gear_cost[iid] = max(50, int(level_of(iid) ** 2 * 24
                                         * r.uniform(0.5, 2.0)))
            continue
        target = max(-55.0, min(110.0, r.gauss(2, 34)))
        gear_cost[iid] = max(50, int(value / (1 + target / 100.0)))

    # Ingredient prices, solved backwards from the gear they make.
    #
    # A resource is worth what the things made of it are worth. Priced from its
    # own level alone, crafted gear came out at a sixtieth of what breaking it
    # paid and every profit column on /items read in the thousands of percent --
    # the app takes the cheaper of buying and crafting, so an unanchored
    # ingredient price is not a small error, it is the whole answer.
    #
    # So each equipment recipe gets a target craft cost, a fraction of what a
    # finished copy sells for, and that total is split across its ingredients in
    # proportion to the prior. An ingredient feeding several recipes takes the
    # mean of what each implies.
    implied = {}
    for r in recipes:
        iid = r["item_id"]
        if iid not in gear_cost:
            continue
        lines = [(ing, qty) for _p, ing, qty in r["ingredients"] if ing in prior]
        share = sum(prior[ing] * qty for ing, qty in lines)
        if share <= 0:
            continue
        target = gear_cost[iid] * gen("craft", iid).uniform(0.5, 1.25)
        for ing, _qty in lines:
            implied.setdefault(ing, []).append(target * prior[ing] / share)
    for iid, p in prior.items():
        got = implied.get(iid)
        unit[iid] = max(5, int(sum(got) / len(got)) if got else p)

    # The nugget price, chosen rather than drawn.
    #
    # web/src/lib/recycle.ts values recycling as base_nuggets * character share
    # * whatever `prices` says one nugget costs, so this single row decides
    # whether the recycle column is dark for every item in the database or
    # brighter than every sale. Drawn from the level prior like any other
    # resource it lands arbitrarily, and it landed low enough that recycling
    # won nothing at all and the "recycle wins" filter was empty.
    #
    # So it is set the way gear and consumable prices are: to make the
    # comparison a real one. Recycling beats selling a resource when
    #
    #     nugget price > unit price / (character share * base nuggets)
    #
    # so the nugget is priced at the first quartile of that ratio across every
    # priced resource that yields any -- about a quarter of them come out worth
    # recycling, the rest worth selling.
    ratios = sorted(
        unit[iid] / (CHARACTER_SHARE * meta[iid][6])
        for iid in ingredients
        if iid in unit and meta[iid][6] and meta[iid][6] > 0
    )
    if ratios:
        unit[NUGGET_ITEM_ID] = max(1, int(ratios[len(ratios) // 4]))

    # A consumable's sell price is drawn around what its ingredients cost, so
    # /opportunities has profitable crafts and losing ones rather than one or
    # the other.
    for iid in consumables:
        r = gen("sell", iid)
        recipe = next(x for x in recipes if x["item_id"] == iid)
        cost = sum(unit.get(ing, 0) * qty for _p, ing, qty in recipe["ingredients"])
        unit[iid] = max(5, int((cost or level_of(iid) * 10) * r.uniform(0.7, 1.9)))

    rows_prices = []
    for iid, u in sorted(unit.items()):
        r = gen("price", iid)
        points = r.randint(6, 11)
        for i, v in enumerate(walk(u, r, points)):
            # Oldest first, ending near now: the last row is what every reader
            # that takes DISTINCT ON ... ORDER BY seen_at DESC will use.
            day = WINDOW_DAYS * (1 - i / max(1, points - 1))
            b1, b10, b100, b1000 = ladder(v, r)
            rows_prices.append((ts(day, 600, r), iid, b1, b10, b100, b1000))

    # Individual listings for gear, in two snapshots so the offer history on an
    # item page has more than one point. The spread inside a snapshot is wide
    # because the real one is: cheapest to dearest is routinely two orders of
    # magnitude, which is why the readers take min(price).
    rows_offers, rows_offer_stats = [], []
    listing_id = 4_000_000
    for iid in equipment:
        r = gen("offers", iid)
        for day in (r.uniform(WINDOW_DAYS - 3, WINDOW_DAYS), r.uniform(0.05, 0.4)):
            when = ts(day, 0, None)
            n = r.randint(3, 9)
            for k in range(n):
                listing_id += 1
                # The cheapest listing is the seeded cost; the rest fan upwards.
                price = gear_cost[iid] if k == 0 else int(
                    gear_cost[iid] * r.uniform(1.1, 14.0))
                rows_offers.append((listing_id, when, iid, meta[iid][2], price))
                for eid, val in roll(ranges.get(iid, []), r).items():
                    rows_offer_stats.append((listing_id, eid, iid, val, when))

    # Instances: what a copy you held actually rolled. Every crushed item gets
    # one, because the crush destroyed a copy that must have existed.
    rows_stats, rows_crushes, rows_placements = [], [], []
    uid = UID_BASE
    held = []
    for iid in equipment:
        if iid not in coefficient:
            continue
        r = gen("instance", iid)
        uid += 1
        held.append((uid, iid))
        for eid, val in roll(ranges.get(iid, []), r).items():
            rows_stats.append((uid, eid, iid, val, ts(crushed_at[iid] + 0.01, 60, r)))
        # One to three crushes: the coefficient is per item type, so repeats are
        # how you find out how tight it is.
        for k in range(r.randint(1, 3)):
            y = round(max(12.0, min(155.0, coefficient[iid] + r.gauss(0, 4))), 2)
            rows_crushes.append((ts(crushed_at[iid] + k * 0.7, 120, r), iid,
                                 coefficient[iid] if k == 0 else y))

    # Placements. Historic ones for copies that were then crushed, then one for
    # an item that has never been broken -- a placement is not a crush, and a
    # copy that sat in the slot and went no further is a real thing to record.
    for uid_held, iid in held[:3]:
        r = gen("place", iid)
        rows_placements.append((ts(crushed_at[iid] + 0.05, 60, r), iid, uid_held))

    pending = [i for i in equipment if i not in coefficient]
    for iid in pending[len(pending) // 3:len(pending) // 3 + 1]:
        r = gen("pending", iid)
        uid += 1
        for eid, val in roll(ranges.get(iid, []), r).items():
            rows_stats.append((uid, eid, iid, val, ts(1.4, 30, r)))
        rows_placements.append((ts(1.35, 30, r), iid, uid))

    # The newest placement is what the breaker page opens on, so it gets a fresh
    # copy of an item a previous crush already measured: the page then answers
    # the question it exists for -- is this copy worth breaking -- rather than
    # leading with a placeholder rate. Richest template first, so the stat lines
    # and the projection both have something to say.
    measured = [i for i in equipment if i in coefficient]
    chosen = sorted(measured, key=lambda i: (
        -sum(1 for _p, e, _lo, _hi in ranges.get(i, []) if e in by_effect), i,
    ))[:1] or equipment[:1]
    for iid in chosen:
        r = gen("slot", iid)
        uid += 1
        for eid, val in roll(ranges.get(iid, []), r).items():
            rows_stats.append((uid, eid, iid, val, ts(0.02, 5, r)))
        rows_placements.append((ts(0.01, 5, r), iid, uid))

    # The bags: ingredients in stacks, plus the gear currently in the slot.
    rows_inventory = []
    bag = gen("bag")
    for iid in ingredients[:: max(1, len(ingredients) // 26)][:26]:
        uid += 1
        rows_inventory.append((uid, iid, bag.randint(2, 180), ts(0.05)))
    for iid in chosen:
        uid += 1
        rows_inventory.append((uid, iid, 1, ts(0.02)))

    # A basket worth pooling: several crafts that share ingredients, which is
    # the case /craft exists for.
    basket = [r["item_id"] for r in recipes if r["job_id"] == 16][:4]
    rows_basket = [(iid, gen("basket", iid).randint(1, 3), ts(0.3))
                   for iid in basket]

    # A couple of verdicts set by hand, so the override is visible next to the
    # automatic ones.
    ranked = sorted((i for i in equipment if i in coefficient),
                    key=lambda i: gear_cost[i], reverse=True)
    rows_marks = [(i, "worth") for i in ranked[:2]] + [(i, "skip") for i in ranked[-2:]]

    if args.dry_run:
        print("dry run -- would write:")
    else:
        insert("prices", "(seen_at, item_id, b1, b10, b100, b1000)", rows_prices)
        insert("offers", "(listing_id, seen_at, item_id, category, price)",
               rows_offers)
        insert("offer_stats", "(listing_id, effect_id, item_id, value, seen_at)",
               rows_offer_stats)
        insert("item_stats", "(uid, effect_id, item_id, value, seen_at)", rows_stats)
        insert("crushes", "(seen_at, item_id, yield_percent)", rows_crushes)
        insert("crush_placements", "(placed_at, item_id, uid)", rows_placements)
        insert("inventory", "(uid, item_id, quantity, seen_at)", rows_inventory)
        insert("craft_basket", "(item_id, quantity, added_at)", rows_basket)
        insert("item_marks", "(item_id, status)", rows_marks)
        insert("app_settings", "(key, value)",
               [("verdict_mode", "automatic"), ("break_threshold_percent", "15")])

    print("  %6d price ladder(s) over %d item(s)" % (len(rows_prices), len(unit)))
    print("  %6d listing(s) with %d stat line(s), %d gear item(s)"
          % (len(rows_offers), len(rows_offer_stats), len(equipment)))
    print("  %6d crush(es) over %d measured item(s)"
          % (len(rows_crushes), len(coefficient)))
    print("  %6d instance stat line(s), %d placement(s)"
          % (len(rows_stats), len(rows_placements)))
    print("  %6d bag row(s), %d basket entr(ies), %d mark(s)"
          % (len(rows_inventory), len(rows_basket), len(rows_marks)))
    print("  %6d consumable recipe(s) for the opportunities view" % len(consumables))


def insert(table, columns, rows, chunk=400):
    """Batched multi-row INSERT. Chunked because a single statement with tens of
    thousands of tuples is slower to parse than it is to run."""
    if not rows:
        return
    for i in range(0, len(rows), chunk):
        psql("INSERT INTO %s %s\nVALUES\n  " % (table, columns)
             + ",\n  ".join("(" + ",".join(lit(v) for v in row) + ")"
                            for row in rows[i:i + chunk])
             + "\nON CONFLICT DO NOTHING;\n")


if __name__ == "__main__":
    main()
