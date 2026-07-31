#!/usr/bin/env python3
"""
Load the rune reference table into Postgres.

Reads docs/brisage-runes.json — the game constants transcribed from
Book 3.xlsx — and resolves each rune against DofusDB to attach its item id and
effect id. The effect id is the important part: it is what the wire uses, so it
is what joins this table to captured data.

    item_detail  {effect_id, value}   the stats on a crushed item
    crush_request  focus effect id    which stat was focused
    runes.effect_id                   -> rune_weight, needed by the model

Without that join the weights in docs/brisage-runes.json cannot be applied to
anything the sniffer captures. See docs/brisage-model.md.

Idempotent: re-running updates rows in place rather than duplicating them.

Usage:
    tools/import_runes.py                 # resolve against DofusDB and load
    tools/import_runes.py --offline       # load weights only, skip the API
    tools/import_runes.py --dry-run       # print what would be written

Requires the `db` container running (docker compose up -d db) and `requests`.
"""
import argparse
import json
import os
import subprocess
import sys

API = "https://api.dofusdb.fr/items"
RUNE_TYPE_ID = 78  # DofusDB item type for runes
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "docs", "brisage-runes.json")

DDL = """
CREATE TABLE IF NOT EXISTS runes (
    rune          TEXT PRIMARY KEY,   -- short name as used in the spreadsheet, e.g. 'Vi'
    stat_fr       TEXT NOT NULL,      -- the stat it comes from, in French
    rune_weight   REAL NOT NULL,      -- game constant, drives how many you get
    stat_per_rune REAL NOT NULL,      -- stat points consumed per rune produced
    item_id       BIGINT,             -- DofusDB item id, NULL if unresolved
    effect_id     BIGINT              -- joins to item_detail effects and to the focus
);
CREATE INDEX IF NOT EXISTS idx_runes_effect ON runes (effect_id);
"""


def psql(sql, quiet=True):
    """Run SQL in the db container. Kept consistent with the other tools here,
    which shell out rather than depend on a Postgres driver."""
    out = subprocess.run(
        ["docker", "exec", "-i", "dofus_db", "psql", "-U", "dofus", "-d", "dofus",
         "-v", "ON_ERROR_STOP=1", "-q" if quiet else "-e", "-f", "-"],
        input=sql, capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit("psql failed:\n" + (out.stderr.strip() or out.stdout.strip()))
    return out.stdout


def lit(v):
    """SQL literal. Numbers pass through; strings are single-quote escaped."""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def resolve(names):
    """rune short name -> (item_id, effect_id), via DofusDB.

    Rune items are named 'Rune <short name>'. Queried in batches; anything that
    does not come back is left unresolved rather than guessed at."""
    import requests

    found = {}
    for i in range(0, len(names), 20):
        chunk = names[i : i + 20]
        params = [("$limit", "100"), ("typeId", str(RUNE_TYPE_ID))]
        params += [("name.fr[$in][]", "Rune " + n) for n in chunk]
        try:
            r = requests.get(API, params=params, timeout=30)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001 - network is best-effort here
            print("  ! DofusDB lookup failed (%s); continuing without ids" % e)
            return found
        for it in r.json().get("data", []):
            name = (it.get("name") or {}).get("fr", "")
            if not name.startswith("Rune "):
                continue
            short = name[len("Rune ") :]
            effects = it.get("effects") or []
            eff = effects[0].get("effectId") if effects else None
            found[short] = (it.get("id"), eff)
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="skip DofusDB, load weights only")
    ap.add_argument("--dry-run", action="store_true", help="print the SQL, write nothing")
    args = ap.parse_args()

    with open(SOURCE, encoding="utf-8") as fh:
        runes = json.load(fh)["runes"]
    print("read %d runes from %s" % (len(runes), os.path.relpath(SOURCE, ROOT)))

    ids = {}
    if not args.offline:
        ids = resolve([r["rune"] for r in runes])
        print("resolved %d/%d against DofusDB" % (len(ids), len(runes)))
        missing = [r["rune"] for r in runes if r["rune"] not in ids]
        if missing:
            print("  unresolved (item_id/effect_id left NULL): " + ", ".join(missing))

    values = []
    for r in runes:
        item_id, effect_id = ids.get(r["rune"], (None, None))
        values.append(
            "(%s,%s,%s,%s,%s,%s)"
            % (
                lit(r["rune"]), lit(r["stat_fr"]), lit(r["rune_weight"]),
                lit(r["stat_per_rune"]), lit(item_id), lit(effect_id),
            )
        )

    sql = DDL + (
        "INSERT INTO runes (rune, stat_fr, rune_weight, stat_per_rune, item_id, effect_id)\n"
        "VALUES\n  " + ",\n  ".join(values) + "\n"
        "ON CONFLICT (rune) DO UPDATE SET\n"
        "  stat_fr = EXCLUDED.stat_fr,\n"
        "  rune_weight = EXCLUDED.rune_weight,\n"
        "  stat_per_rune = EXCLUDED.stat_per_rune,\n"
        # keep an id we already have if this run could not resolve one
        "  item_id = COALESCE(EXCLUDED.item_id, runes.item_id),\n"
        "  effect_id = COALESCE(EXCLUDED.effect_id, runes.effect_id);\n"
    )

    if args.dry_run:
        print("\n--- SQL (not executed) ---\n" + sql)
        return

    psql(sql)
    print(psql(
        "SELECT count(*) AS runes, count(item_id) AS with_item, "
        "count(effect_id) AS with_effect FROM runes;", quiet=False
    ).strip())


if __name__ == "__main__":
    main()
