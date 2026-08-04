#!/usr/bin/env python3
"""Fill `items.recycle_nuggets` from the client's own data files.

Why this is not just another DofusDB column: `recyclingNuggets` on an item is
the yield of *that item as a resource*, and it is 0 for every craftable one --
4511 of them. The client does not read the field for those, it decomposes the
item into resources and sums them; the readable `RecycleUi.GetItemNuggets`
takes a `Dictionary<int, int> resources`, not an item. Storing the raw field
therefore writes 0 for exactly the items a craft dashboard cares about, and 0
reads as "not worth recycling" rather than as "not computed".

So the effective base is:

    own value, when the item has one          (3702 items, a leaf resource)
    else the recipe expanded to leaves        (4480 items, summed x quantity)

Read straight from the install rather than from DofusDB, for three reasons: the
bundle is the source DofusDB itself mirrors, it covers all 21748 items with no
paging, and the recipe tree needs thousands of lookups that would otherwise be
thousands of requests. **Read-only** -- this opens two files under
DofusContent and never writes there.

    pip install --user UnityPy
    python3 tools/extract_nuggets.py            # update the items table
    python3 tools/extract_nuggets.py --dry-run  # report, write nothing
    python3 tools/extract_nuggets.py --json out.json
"""
import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict

CONTENT = os.environ.get(
    "DOFUS_CONTENT",
    "/Applications/Ankama/Dofus-dofus3/DofusContent/Content/Data",
)
ITEMS_BUNDLE = "data_assets_itemsdataroot.asset.bundle"
RECIPES_BUNDLE = "data_assets_recipesdataroot.asset.bundle"

# The bundles carry a stripped version string, so UnityPy guesses and crashes.
# The real one is in ~/Library/Logs/Ankama/Dofus/Player.log; it only has to be
# close enough for the type tree, and this has been stable across builds.
UNITY_VERSION = os.environ.get("DOFUS_UNITY_VERSION", "6000.3.16f1")

# A recipe tree deeper than this is a data error rather than a real craft; the
# cycle guard already covers an ingredient list that loops back on itself.
MAX_DEPTH = 12


def psql(sql, rows=False):
    """Same shell-out the other tools here use, so there is one DB dependency."""
    base = ["docker", "exec", "-i", "dofus_db", "psql", "-U", "dofus", "-d", "dofus"]
    args = base + (["-tAF", "|", "-c", sql] if rows else ["-q", "-v", "ON_ERROR_STOP=1", "-c", sql])
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("psql failed: " + (r.stderr.strip() or r.stdout.strip()))
    return [l.split("|") for l in r.stdout.splitlines() if l] if rows else None


def load_bundle(name):
    """Every SerializeReference record in one asset bundle.

    `read_typetree()` rather than `obj.read()`: the latter segfaults on these
    containers, taking the interpreter with it rather than raising.
    """
    import warnings

    import UnityPy
    import UnityPy.config

    warnings.filterwarnings("ignore")  # the version fallback warns once per file
    UnityPy.config.FALLBACK_UNITY_VERSION = UNITY_VERSION

    path = os.path.join(CONTENT, name)
    if not os.path.exists(path):
        sys.exit("no such bundle: %s\nSet DOFUS_CONTENT to the Content/Data directory." % path)
    env = UnityPy.load(path)
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        tree = obj.read_typetree()
        refs = (tree.get("references") or {}).get("RefIds")
        if refs:
            return [e["data"] for e in refs if isinstance(e.get("data"), dict)]
    sys.exit("no SerializeReference records in " + name)


def read_game_data():
    """({item_id: own nuggets}, {result_id: (ingredient_ids, quantities)})."""
    nuggets = {}
    for t in load_bundle(ITEMS_BUNDLE):
        if "id" in t and "recyclingNuggets" in t:
            nuggets[int(t["id"])] = float(t["recyclingNuggets"])
    recipes = {}
    for t in load_bundle(RECIPES_BUNDLE):
        if "resultId" in t:
            recipes[int(t["resultId"])] = (
                [int(x) for x in t.get("ingredientIds") or []],
                [int(x) for x in t.get("quantities") or []],
            )
    return nuggets, recipes


def leaves(item_id, recipes, depth=0, seen=()):
    """{leaf_id: quantity} -- the item decomposed until nothing has a recipe."""
    if item_id in seen or depth >= MAX_DEPTH or item_id not in recipes:
        return {item_id: 1}
    ingredients, quantities = recipes[item_id]
    out = defaultdict(int)
    for ing, qty in zip(ingredients, quantities):
        for leaf, n in leaves(ing, recipes, depth + 1, seen + (item_id,)).items():
            out[leaf] += n * qty
    return dict(out)


def effective(nuggets, recipes, prefer_recipe=False):
    """{item_id: base nuggets per unit}, decomposing the craftables.

    `prefer_recipe` decides the 347 items that have *both* an own value and a
    recipe, which no measurement has yet separated -- see the note in
    web/src/lib/recycle.ts. Everything else is unambiguous either way.
    """
    out = {}
    for item_id, own in nuggets.items():
        if own and not (prefer_recipe and item_id in recipes):
            out[item_id] = own
            continue
        out[item_id] = sum(
            nuggets.get(leaf, 0.0) * qty for leaf, qty in leaves(item_id, recipes).items()
        )
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    ap.add_argument("--json", metavar="PATH", help="also dump {item_id: nuggets}")
    ap.add_argument("--prefer-recipe", action="store_true",
                    help="decompose even an item that has its own value (see effective())")
    args = ap.parse_args()

    nuggets, recipes = read_game_data()
    print("bundle: %d item(s), %d recipe(s)" % (len(nuggets), len(recipes)))

    base = effective(nuggets, recipes, args.prefer_recipe)
    raw_nonzero = sum(1 for v in nuggets.values() if v)
    now_nonzero = sum(1 for v in base.values() if v)
    print("  %d with an own value, %d after decomposing recipes (+%d)"
          % (raw_nonzero, now_nonzero, now_nonzero - raw_nonzero))

    if args.json:
        with open(args.json, "w") as fh:
            json.dump({str(k): v for k, v in sorted(base.items())}, fh)
        print("  wrote " + args.json)

    known = {int(r[0]) for r in psql("SELECT item_id FROM items", rows=True) if r[0]}
    pairs = [(i, base[i]) for i in sorted(known & set(base))]
    print("  %d of %d row(s) in `items` matched" % (len(pairs), len(known)))
    if args.dry_run or not pairs:
        return

    # Updated rather than inserted: a row here carries a name, a level and an
    # icon that this tool knows nothing about, and an id-only row would show up
    # in every listing as a blank item.
    for i in range(0, len(pairs), 500):
        values = ",".join("(%d,%r::double precision)" % p for p in pairs[i:i + 500])
        psql("UPDATE items SET recycle_nuggets = v.n FROM (VALUES %s) AS v(id, n)"
             " WHERE items.item_id = v.id;" % values)
    print("  written")

    for line in psql(
        "SELECT count(*) FILTER (WHERE recycle_nuggets > 0),"
        " count(*) FILTER (WHERE recycle_nuggets = 0),"
        " count(*) FILTER (WHERE recycle_nuggets IS NULL) FROM items", rows=True):
        print("\nitems: %s with a yield, %s at zero, %s unknown" % tuple(line))


if __name__ == "__main__":
    main()
