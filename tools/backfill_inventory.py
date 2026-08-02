#!/usr/bin/env python3
"""
Fill `inventory` from the newest archived inventory listing.

The sniffer writes this table live, but only from the moment it learned to: the
listings are already in `packets` from before that, and the newest one is a
complete snapshot of the bags. Replaying it means the craft basket can say what
you already own without waiting for the game to send another.

    field 1  message  REPEATED, one per slot
        field 1  varint   slot
        field 4  message
            field 1  varint   instance uid
            field 3  varint   how many are in the stack (absent = 1)
            field 4  varint   item type id

Mirrors interpret::inventory. A snapshot replaces the table wholesale, exactly
as the live path does -- what is not in the newest listing is not in the bags.

Usage:
    tools/backfill_inventory.py             # replay the newest listing
    tools/backfill_inventory.py --dry-run   # report only
"""
import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYMAP = os.path.join(ROOT, "sniffer", "keymap.json")


def psql(sql, rows=False):
    args = ["docker", "exec", "-i", "dofus_db", "psql", "-U", "dofus", "-d", "dofus",
            "-v", "ON_ERROR_STOP=1"]
    args += ["-t", "-A", "-F", "\t", "-c", sql] if rows else ["-q", "-f", "-"]
    out = subprocess.run(args, input=None if rows else sql, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("psql failed:\n" + (out.stderr.strip() or out.stdout.strip()))
    if rows:
        return [l.split("\t") for l in out.stdout.strip().split("\n") if l.strip()]
    return out.stdout


def inventory_key():
    """The wire key for the inventory listing -- it rotates per client build."""
    try:
        with open(KEYMAP, encoding="utf-8") as fh:
            k = json.load(fh).get("inventory")
            if k:
                return k
    except (OSError, ValueError) as e:
        print("  ! could not read %s (%s); assuming 'iss'" % (KEYMAP, e))
    return "iss"


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
            i += 4
        elif wt == 1:
            i += 8
        else:
            return


def parse_inventory(body):
    """[(uid, item_id, quantity)] -- one entry per occupied slot."""
    out = []
    for f, wt, slot in fields(body):
        if f != 1 or wt != 2:
            continue
        for f2, wt2, entry in fields(slot):
            if f2 != 4 or wt2 != 2:
                continue
            uid = item = None
            quantity = 1
            for f3, wt3, v in fields(entry):
                if wt3 != 0:
                    continue
                if f3 == 1:
                    uid = v
                elif f3 == 3:
                    quantity = v
                elif f3 == 4:
                    item = v
            if uid and item:
                out.append((uid, item, quantity))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    args = ap.parse_args()

    key = inventory_key()
    rows = psql(
        "SELECT encode(body,'hex'), captured_at FROM packets"
        " WHERE msg_key = '%s' AND body IS NOT NULL"
        " ORDER BY captured_at DESC, id DESC LIMIT 1" % key.replace("'", ""),
        rows=True,
    )
    if not rows:
        sys.exit("no archived %s messages; nothing to replay" % key)

    hexed, captured_at = rows[0]
    items = parse_inventory(bytes.fromhex(hexed))
    print("backfill: newest %s listing at %s -- %d slot(s), %d unit(s)"
          % (key, captured_at[:19], len(items), sum(q for _u, _i, q in items)))
    if not items:
        sys.exit("  ! parsed nothing; refusing to empty the table")

    stacked = [(u, i, q) for u, i, q in items if q > 1]
    for uid, item, quantity in stacked[:8]:
        name = psql("SELECT coalesce(name_fr,'?') FROM items WHERE item_id = %d" % item,
                    rows=True)
        print("    %-8d x%-5d %s" % (item, quantity, name[0][0] if name else "?"))
    if args.dry_run:
        return

    values = ",\n  ".join("(%d,%d,%d)" % r for r in items)
    # Replace, do not merge: the listing is the whole bag, so a row it does not
    # mention is an item that is no longer there.
    psql("BEGIN;\nDELETE FROM inventory;\n"
         "INSERT INTO inventory (uid, item_id, quantity)\nVALUES\n  " + values +
         "\nON CONFLICT (uid) DO UPDATE SET item_id = EXCLUDED.item_id,"
         " quantity = EXCLUDED.quantity, seen_at = now();\nCOMMIT;\n")
    print("  wrote %d row(s)" % len(items))


if __name__ == "__main__":
    main()
