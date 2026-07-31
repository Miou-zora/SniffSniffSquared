#!/usr/bin/env python3
"""
Fill `offers` and `offer_stats` from `price_list` messages already archived.

The sniffer kept only one offer per message until the listing shape was
understood, so every equipment panel ever captured is sitting in `packets` with
its rolled stats intact and unread -- 371 offers across 19 messages when this
was written. Nothing needs re-capturing; it only needs parsing.

Mirrors `interpret::price_list` in the Rust app. The shapes:

    field 1  varint      category
    field 2  message     REPEATED, one per offer
        field 1  varint  item id
        field 4  message REPEATED, one stat line: 8 = value, 9 = effect id
        field 5  packed  x1, x10, x100, x1000  (gear quotes only x1)
        field 7  varint  listing id
    field 3  varint      item id, when the offers do not repeat it

An offer carrying stat lines is one specific copy of a piece of gear and
belongs in `offers`; one without them is a fungible stack and belongs in
`prices`, which the sniffer already wrote correctly. Only the former is
backfilled here -- re-inserting the stacks would duplicate history.

Usage:
    tools/backfill_offers.py             # parse and write
    tools/backfill_offers.py --dry-run   # report only
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


def price_key():
    """The wire key for price_list — it rotates per client build."""
    try:
        with open(KEYMAP, encoding="utf-8") as fh:
            k = json.load(fh).get("price_list")
            if k:
                return k
    except (OSError, ValueError) as e:
        print("  ! could not read %s (%s); assuming 'kea'" % (KEYMAP, e))
    return "kea"


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
            i += 4
        elif wt == 1:
            i += 8
        else:
            return


def packed(b):
    out, i = [], 0
    while i < len(b):
        try:
            v, i = varint(b, i)
        except ValueError:
            return out
        out.append(v)
    return out


def parse_offers(body):
    """[(listing_id, item_id, price, [(effect_id, value)])] for gear offers only."""
    category = 0
    outer_item = 0
    offers = []
    for f, wt, payload in fields(body):
        if f == 1 and wt == 0:
            category = payload
        elif f == 3 and wt == 0:
            outer_item = payload
        elif f == 2 and wt == 2:
            item = listing = 0
            ladder, stats = [], []
            for f2, wt2, p2 in fields(payload):
                if f2 == 1 and wt2 == 0:
                    item = p2
                elif f2 == 4 and wt2 == 2:
                    value = effect = None
                    for f3, wt3, p3 in fields(p2):
                        if f3 == 8 and wt3 == 0:
                            value = p3
                        elif f3 == 9 and wt3 == 0:
                            effect = p3
                    # weapon damage arrives as a nested dice with no field 8;
                    # it yields no rune, so it is dropped rather than guessed
                    if value is not None and effect is not None:
                        stats.append((effect, value))
                elif f2 == 5 and wt2 == 2:
                    ladder = packed(p2)
                elif f2 == 7 and wt2 == 0:
                    listing = p2
            if stats and ladder:
                offers.append((listing, item or outer_item, ladder[0], stats))
    return category, offers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    args = ap.parse_args()

    key = price_key()
    rows = psql(
        "SELECT id, encode(body,'hex'), captured_at FROM packets"
        " WHERE msg_key = '%s' ORDER BY id" % key.replace("'", ""),
        rows=True,
    )
    print("backfill: %d archived %s messages" % (len(rows), key))

    # Keyed, not appended: the same listing is re-described every time the panel
    # is opened, and Postgres rejects an INSERT hitting one ON CONFLICT key twice
    # in a single statement. Rows are ordered by packet id, so the last
    # observation of a listing wins.
    offers, stats = {}, {}
    messages = 0
    for _pid, hexed, seen_at in rows:
        if not hexed:
            continue
        category, parsed = parse_offers(bytes.fromhex(hexed))
        if parsed:
            messages += 1
        for listing, item, price, lines in parsed:
            offers[listing] = (item, category, price, seen_at)
            for effect, value in lines:
                stats[(listing, effect)] = (item, value, seen_at)

    print("  %d listing message(s), %d offer(s), %d stat line(s)"
          % (messages, len(offers), len(stats)))
    if not offers or args.dry_run:
        return

    values = ",\n  ".join(
        "(%d,%d,%d,%d,'%s')" % (listing, item, category, price, seen_at)
        for listing, (item, category, price, seen_at) in sorted(offers.items())
    )
    psql(
        "INSERT INTO offers (listing_id, item_id, category, price, seen_at)\nVALUES\n  "
        + values
        + "\nON CONFLICT DO NOTHING;\n"
    )

    values = ",\n  ".join(
        "(%d,%d,%d,%d,'%s')" % (listing, effect, item, value, seen_at)
        for (listing, effect), (item, value, seen_at) in sorted(stats.items())
    )
    psql(
        "INSERT INTO offer_stats (listing_id, effect_id, item_id, value, seen_at)\nVALUES\n  "
        + values
        + "\nON CONFLICT (listing_id, effect_id) DO UPDATE SET"
          " value = EXCLUDED.value, seen_at = EXCLUDED.seen_at;\n"
    )

    print()
    for line in psql(
        "SELECT o.item_id, COALESCE(i.name_fr,'?'), count(DISTINCT o.listing_id),"
        " min(o.price), max(o.price)"
        " FROM offers o LEFT JOIN items i USING (item_id)"
        " GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15", rows=True
    ):
        print("  %-7s %-28s %3s offer(s)  %10s .. %-10s" % tuple(line))


if __name__ == "__main__":
    main()
