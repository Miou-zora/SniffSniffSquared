#!/usr/bin/env python3
"""
Fill the `items` table with names, levels and types, and backfill `item_stats`
from packets captured before the sniffer wrote that table.

Two jobs, because they are the two halves of making a captured item id mean
something:

  backfill   re-parse archived `item_detail` messages out of `packets` into
             `item_stats`. The sniffer writes that table live now, but every
             item captured before it did is still recoverable from `body`.

  enrich     look up every item id the database has ever seen -- across
             item_stats, crushes, crush_placements and prices -- against
             DofusDB, and store the name, level and type.

The sniffer does not do the enrichment itself on purpose: the capture path
takes no network dependency, so a DofusDB outage can never cost packets. That
makes this an offline step to re-run whenever new item ids show up.

Note DofusDB is authoritative for *name and level* only. For an item's stat
values the wire wins -- its `effects` are the template range for the item type,
and at least one captured item reported values outside that range. See
docs/brisage-model.md.

Usage:
    tools/import_items.py                  # backfill, then enrich
    tools/import_items.py --no-backfill    # names only
    tools/import_items.py --no-enrich      # no network; parse packets only
    tools/import_items.py --refresh        # re-resolve ids already named
    tools/import_items.py --dry-run        # report, write nothing

Requires the `db` container running and, unless --no-enrich, `requests`.
"""
import argparse
import json
import os
import subprocess
import sys

API = "https://api.dofusdb.fr/items"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYMAP = os.path.join(ROOT, "sniffer", "keymap.json")

DDL = """
CREATE TABLE IF NOT EXISTS item_stats (
    uid       BIGINT NOT NULL,
    effect_id BIGINT NOT NULL,
    item_id   BIGINT NOT NULL,
    value     BIGINT NOT NULL,
    seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (uid, effect_id)
);
CREATE INDEX IF NOT EXISTS idx_item_stats_item ON item_stats (item_id);
CREATE TABLE IF NOT EXISTS items (
    item_id    BIGINT PRIMARY KEY,
    name_fr    TEXT,
    level      INT,
    type_id    BIGINT,
    type_fr    TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


def psql(sql, rows=False):
    """Run SQL in the db container. Shells out rather than depending on a
    Postgres driver, consistent with the other tools here."""
    args = ["docker", "exec", "-i", "dofus_db", "psql", "-U", "dofus", "-d", "dofus",
            "-v", "ON_ERROR_STOP=1"]
    args += ["-t", "-A", "-F", "\t", "-c", sql] if rows else ["-q", "-f", "-"]
    out = subprocess.run(args, input=None if rows else sql, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("psql failed:\n" + (out.stderr.strip() or out.stdout.strip()))
    if rows:
        return [l.split("\t") for l in out.stdout.strip().split("\n") if l.strip()]
    return out.stdout


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


# ---- protobuf, just enough to walk an item_detail ---------------------------

def varint(b, i):
    r = s = 0
    while i < len(b):
        c = b[i]; i += 1
        r |= (c & 0x7F) << s
        if not c & 0x80:
            return r, i
        s += 7
    raise ValueError("truncated varint")


def fields(b):
    """(field number, wire type, payload) for one message level."""
    i = 0
    while i < len(b):
        try:
            key, i = varint(b, i)
        except ValueError:
            return
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = varint(b, i); yield f, wt, v
        elif wt == 2:
            n, i = varint(b, i)
            if i + n > len(b):
                return
            yield f, wt, b[i:i + n]; i += n
        elif wt == 5:
            yield f, wt, b[i:i + 4]; i += 4
        elif wt == 1:
            yield f, wt, b[i:i + 8]; i += 8
        else:
            return


def parse_item_detail(body):
    """(uid, item_id, [(effect_id, value)]) — mirrors interpret::item_detail_full.

    Shape: field 2 > field 4 > { 1: uid, 4: item id, 5*: { 8: value, 9: effect } }
    Note the stat line carries value before effect id, which reads backwards.
    """
    for f, wt, payload in fields(body):
        if f != 2 or wt != 2:
            continue
        for f2, wt2, p2 in fields(payload):
            if f2 != 4 or wt2 != 2:
                continue
            uid = item = None
            stats = []
            for f3, wt3, p3 in fields(p2):
                if f3 == 1 and wt3 == 0:
                    uid = p3
                elif f3 == 4 and wt3 == 0:
                    item = p3
                elif f3 == 5 and wt3 == 2:
                    value = effect = None
                    for f4, wt4, p4 in fields(p3):
                        if f4 == 8 and wt4 == 0:
                            value = p4
                        elif f4 == 9 and wt4 == 0:
                            effect = p4
                    if value is not None and effect is not None:
                        stats.append((effect, value))
            if uid and item:
                return uid, item, stats
    return None


def detail_key():
    """The wire key for item_detail, from keymap.json — it rotates per build."""
    try:
        with open(KEYMAP, encoding="utf-8") as fh:
            k = json.load(fh).get("item_detail")
            if k:
                return k
    except (OSError, ValueError) as e:
        print("  ! could not read %s (%s); assuming 'kev'" % (KEYMAP, e))
    return "kev"


def backfill(dry_run):
    key = detail_key()
    rows = psql(
        "SELECT id, encode(body,'hex') FROM packets WHERE msg_key = %s ORDER BY id" % lit(key),
        rows=True,
    )
    print("backfill: %d archived %s messages" % (len(rows), key))
    if not rows:
        return

    # Keyed, not appended: the same instance is re-described every time it is
    # handled -- placed in the breaker, then crushed -- and Postgres rejects an
    # INSERT that hits one ON CONFLICT key twice in a single statement. Rows are
    # ordered by packet id, so the last description of an instance wins.
    seen, skipped = {}, 0
    for _pid, hexed in rows:
        parsed = parse_item_detail(bytes.fromhex(hexed))
        if not parsed:
            skipped += 1
            continue
        uid, item, stats = parsed
        for effect, value in stats:
            seen[(uid, effect)] = (item, value)

    values = ["(%d,%d,%d,%d)" % (uid, effect, item, value)
              for (uid, effect), (item, value) in sorted(seen.items())]
    instances = {uid for uid, _ in seen}
    print("  %d instances, %d stat lines%s" % (
        len(instances), len(values), ", %d unparsable" % skipped if skipped else ""))
    if not values or dry_run:
        return
    psql(
        "INSERT INTO item_stats (uid, effect_id, item_id, value)\nVALUES\n  "
        + ",\n  ".join(values)
        + "\nON CONFLICT (uid, effect_id) DO UPDATE SET"
          " value = EXCLUDED.value, seen_at = now();\n"
    )


def observed_item_ids(refresh):
    """Every item id the database has seen, from all four tables that carry one."""
    where = "" if refresh else " WHERE i.item_id IS NULL OR i.name_fr IS NULL"
    sql = """
    SELECT DISTINCT s.item_id FROM (
        SELECT item_id FROM item_stats
        UNION SELECT item_id FROM crushes WHERE item_id IS NOT NULL
        UNION SELECT item_id FROM crush_placements
        UNION SELECT item_id FROM prices
    ) s LEFT JOIN items i USING (item_id)%s ORDER BY 1
    """ % where
    return [int(r[0]) for r in psql(sql, rows=True) if r[0]]


def enrich(refresh, dry_run):
    import requests

    ids = observed_item_ids(refresh)
    print("enrich: %d item id(s) to resolve%s" % (len(ids), "" if ids else " — nothing to do"))
    if not ids:
        return

    found = {}
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        params = [("$limit", "100")] + [("id[$in][]", str(x)) for x in chunk]
        try:
            r = requests.get(API, params=params, timeout=30)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001 — network is best-effort
            print("  ! DofusDB lookup failed (%s); stopping with %d resolved" % (e, len(found)))
            break
        for it in r.json().get("data", []):
            t = it.get("type") or {}
            found[it.get("id")] = (
                (it.get("name") or {}).get("fr"),
                it.get("level"),
                t.get("id"),
                (t.get("name") or {}).get("fr"),
            )

    missing = [x for x in ids if x not in found]
    print("  resolved %d/%d%s" % (
        len(found), len(ids),
        "; unresolved: " + ", ".join(map(str, missing)) if missing else ""))
    if not found or dry_run:
        return

    values = ",\n  ".join(
        "(%d,%s,%s,%s,%s)" % (k, lit(n), lit(lv), lit(ti), lit(tn))
        for k, (n, lv, ti, tn) in sorted(found.items())
    )
    psql(
        "INSERT INTO items (item_id, name_fr, level, type_id, type_fr)\nVALUES\n  "
        + values
        + "\nON CONFLICT (item_id) DO UPDATE SET\n"
          "  name_fr = COALESCE(EXCLUDED.name_fr, items.name_fr),\n"
          "  level = COALESCE(EXCLUDED.level, items.level),\n"
          "  type_id = COALESCE(EXCLUDED.type_id, items.type_id),\n"
          "  type_fr = COALESCE(EXCLUDED.type_fr, items.type_fr),\n"
          "  updated_at = now();\n"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-backfill", action="store_true", help="skip re-parsing packets")
    ap.add_argument("--no-enrich", action="store_true", help="skip DofusDB, no network")
    ap.add_argument("--refresh", action="store_true", help="re-resolve ids already named")
    ap.add_argument("--dry-run", action="store_true",
                    help="report without writing data (tables are still created)")
    args = ap.parse_args()

    # Idempotent, and the reads below need the tables to exist, so this runs
    # even under --dry-run. What --dry-run suppresses is the data.
    psql(DDL)
    if not args.no_backfill:
        backfill(args.dry_run)
    if not args.no_enrich:
        enrich(args.refresh, args.dry_run)

    print()
    for line in psql(
        "SELECT i.item_id, COALESCE(i.name_fr,'?'), COALESCE(i.level::text,'?'),"
        " COALESCE(i.type_fr,'?'), count(DISTINCT s.uid), count(s.*)"
        " FROM items i LEFT JOIN item_stats s USING (item_id)"
        " GROUP BY 1,2,3,4 ORDER BY 2", rows=True
    ):
        print("  %-7s %-28s lvl %-4s %-14s %s instance(s), %s stat line(s)" % tuple(line))


if __name__ == "__main__":
    main()
