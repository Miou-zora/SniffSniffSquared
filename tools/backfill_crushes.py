#!/usr/bin/env python3
"""
Recover crushes the sniffer parsed as "not a crush".

The interpreter required a rune list, so a crush that yielded nothing — every
line rounded below one rune, which is what a low coefficient on a small item
does — was dropped whole, taking its yield with it. That yield is the only
thing `crushes` stores and the only reading of that item's coefficient there
will ever be: the instance is destroyed by the crush.

The messages are still in `packets`, so nothing needs re-crushing.

    field 1  message
        field 1  message  REPEATED, one per rune type  (absent here)
        field 2  i32      float32 yield, 0.0-1.0
        field 3  varint   the crushed item's INSTANCE uid

The item *type* is not in the message. It comes from an `item_detail` seen
earlier for the same uid, which `item_stats` records — a crush whose uid was
never described lands with a NULL item_id, exactly as the live path does.

Usage:
    tools/backfill_crushes.py             # insert what is missing
    tools/backfill_crushes.py --dry-run   # report only
"""
import argparse
import json
import os
import struct
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


def crush_key():
    """The wire key for crush_result — it rotates per client build."""
    try:
        with open(KEYMAP, encoding="utf-8") as fh:
            k = json.load(fh).get("crush_result")
            if k:
                return k
    except (OSError, ValueError) as e:
        print("  ! could not read %s (%s); assuming 'kfy'" % (KEYMAP, e))
    return "kfy"


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
            if i + 4 > len(b):
                return
            yield f, wt, b[i:i + 4]; i += 4
        elif wt == 1:
            i += 8
        else:
            return


def parse_crush(body):
    """(uid, yield_fraction) or None. Mirrors interpret::crush_result."""
    for f, wt, payload in fields(body):
        if f != 1 or wt != 2:
            continue
        uid = None
        yield_fraction = None
        for f2, wt2, p2 in fields(payload):
            if f2 == 2 and wt2 == 5:
                yield_fraction = struct.unpack("<f", p2)[0]
            elif f2 == 3 and wt2 == 0:
                uid = p2
        if uid and yield_fraction is not None:
            return uid, yield_fraction
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    args = ap.parse_args()

    key = crush_key()
    rows = psql(
        "SELECT id, encode(body,'hex'), captured_at FROM packets"
        " WHERE msg_key = '%s' ORDER BY id" % key.replace("'", ""),
        rows=True,
    )
    print("backfill: %d archived %s messages" % (len(rows), key))

    # uid -> item type, from the item_detail messages the sniffer already stored
    uid_type = {int(r[0]): int(r[1]) for r in psql(
        "SELECT DISTINCT uid, item_id FROM item_stats", rows=True) if r[0] and r[1]}

    # Matched on the second: the sniffer's now() and the packet's captured_at are
    # taken microseconds apart and will not compare equal.
    have = {r[0] for r in psql(
        "SELECT to_char(date_trunc('second', seen_at), 'YYYY-MM-DD HH24:MI:SS')"
        " FROM crushes", rows=True) if r[0]}

    missing = []
    for _pid, hexed, captured_at in rows:
        if not hexed:
            continue
        parsed = parse_crush(bytes.fromhex(hexed))
        if not parsed:
            continue
        uid, fraction = parsed
        if captured_at[:19] in have:
            continue
        missing.append((uid_type.get(uid), fraction * 100.0, captured_at))

    print("  %d crush(es) missing from the table" % len(missing))
    for item_id, percent, captured_at in missing[-10:]:
        print("    %-8s %6.2f%%  %s" % (item_id or "unknown", percent, captured_at[:19]))
    if not missing or args.dry_run:
        return

    values = ",\n  ".join(
        "(%s,%f,'%s')" % ("NULL" if item_id is None else item_id, percent, captured_at)
        for item_id, percent, captured_at in missing
    )
    psql("INSERT INTO crushes (item_id, yield_percent, seen_at)\nVALUES\n  " + values + ";\n")
    print("  inserted %d" % len(missing))


if __name__ == "__main__":
    main()
