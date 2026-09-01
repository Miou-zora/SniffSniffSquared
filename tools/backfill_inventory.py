#!/usr/bin/env python3
"""
Rebuild `inventory` from the archive: the newest listing, then every change.

The sniffer writes this table live, but only from the moment it learned to. The
messages are already in `packets` from before that, and replaying them means the
craft basket can say what you own without waiting for the game to send another
listing -- which it does rarely, whereas a purchase is described immediately.

    inventory        field 1  message  REPEATED, one per slot
                         field 1  varint  slot
                         field 4  message  the entry below

    entry            field 1  varint  instance uid
                     field 3  varint  stack size (absent = 1)
                     field 4  varint  item type id

    inventory_add    the same shape, one slot
    inventory_quan.  field 4  message
                         field 1  varint  the new stack size
                         field 2  varint  instance uid
    inventory_remove field 3  varint  the uid that left

Mirrors interpret::inventory and friends. The listing replaces the table
wholesale, exactly as the live path does -- what it does not mention is not in
the bags -- and the changes after it are applied in capture order.

Usage:
    tools/backfill_inventory.py             # replay listing + changes
    tools/backfill_inventory.py --dry-run   # report only
"""
import argparse
import subprocess
import sys

import wirekeys


def psql(sql, rows=False):
    args = ["docker", "exec", "-i", "dofus_db", "psql", "-U", "dofus", "-d", "dofus",
            "-v", "ON_ERROR_STOP=1"]
    args += ["-t", "-A", "-F", "\t", "-c", sql] if rows else ["-q", "-f", "-"]
    out = subprocess.run(args, input=None if rows else sql, capture_output=True,
                         text=True, encoding="utf-8")
    if out.returncode != 0:
        sys.exit("psql failed:\n" + (out.stderr.strip() or out.stdout.strip()))
    if rows:
        return [l.split("\t") for l in out.stdout.strip().split("\n") if l.strip()]
    return out.stdout


def wire_keys():
    """Semantic name -> wire key, resolved the way the sniffer resolves them.

    These four used to be hardcoded here as iss/iun/iul/ivf, which the
    2026-08-04 rotation retired. That was not merely stale: `iun` is still on
    the wire carrying pods, so the old table did not fail, it parsed pods as
    inventory additions."""
    return wirekeys.keys("inventory", "inventory_add",
                         "inventory_quantity", "inventory_remove")


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


def parse_inventory(body, message="inventory"):
    """[(uid, item_id, quantity)] -- one entry per occupied slot.

    Field numbers come from sniffer/schema.json rather than from constants here,
    because they rotate with the build. The 2026-08-04 update moved the slot list
    from 1 to 3 and the entry from 4 to 5, and — the dangerous one — swapped uid
    and item id inside the entry. Both are varints, so the old numbers over new
    bytes yield a perfectly plausible row with the two exchanged.
    """
    inv = wirekeys.field_numbers(message)
    slot_f = wirekeys.field_numbers("slot")
    entry_f = wirekeys.field_numbers("item_entry")
    out = []
    for f, wt, slot in fields(body):
        if f != inv["slot"] or wt != 2:
            continue
        for f2, wt2, entry in fields(slot):
            if f2 != slot_f["entry"] or wt2 != 2:
                continue
            uid = item = None
            quantity = 1
            for f3, wt3, v in fields(entry):
                if wt3 != 0:
                    continue
                if f3 == entry_f["uid"]:
                    uid = v
                elif f3 == entry_f["quantity"]:
                    quantity = v
                elif f3 == entry_f["item_id"]:
                    item = v
            if uid and item:
                out.append((uid, item, quantity))
    return out


def parse_quantity(body):
    """(uid, new stack size) from an inventory_quantity message."""
    outer = wirekeys.field_numbers("inventory_quantity")
    change = wirekeys.field_numbers("quantity_change")
    for f, wt, now in fields(body):
        if f != outer["change"] or wt != 2:
            continue
        uid = quantity = None
        for f2, wt2, v in fields(now):
            if wt2 != 0:
                continue
            if f2 == change["quantity"]:
                quantity = v
            elif f2 == change["uid"]:
                uid = v
        if uid:
            return uid, quantity or 0
    return None


def parse_remove(body):
    """The uid an inventory_remove message says has gone."""
    uid_f = wirekeys.field_numbers("inventory_remove")["uid"]
    for f, wt, v in fields(body):
        if f == uid_f and wt == 0 and v:
            return v
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    args = ap.parse_args()

    keys = wire_keys()
    listing = keys["inventory"]
    rows = psql(
        "SELECT id, encode(body,'hex'), captured_at FROM packets"
        " WHERE msg_key = '%s' AND body IS NOT NULL"
        " ORDER BY captured_at DESC, id DESC LIMIT 1" % listing.replace("'", ""),
        rows=True,
    )
    if not rows:
        wirekeys.explain_empty_scan("inventory", listing, psql)
        sys.exit("no archived %s messages; nothing to replay" % listing)

    from_id, hexed, captured_at = rows[0]
    items = parse_inventory(bytes.fromhex(hexed))
    print("backfill: newest %s listing at %s -- %d slot(s), %d unit(s)"
          % (listing, captured_at[:19], len(items), sum(q for _u, _i, q in items)))
    if not items:
        sys.exit("  ! parsed nothing; refusing to empty the table")

    # Everything that happened since, in capture order. The listing is a
    # snapshot of one moment; a purchase minutes later is only in these.
    bag = {uid: [item, quantity] for uid, item, quantity in items}
    changes = psql(
        "SELECT msg_key, encode(body,'hex') FROM packets"
        " WHERE id > %d AND msg_key IN ('%s','%s','%s') AND body IS NOT NULL"
        " ORDER BY id"
        % (int(from_id), keys["inventory_add"], keys["inventory_quantity"],
           keys["inventory_remove"]),
        rows=True,
    )
    applied = 0
    for key, body_hex in changes:
        body = bytes.fromhex(body_hex)
        if key == keys["inventory_add"]:
            # same envelope as a full listing, but read against its own shape
            added = parse_inventory(body, "inventory_add")
            for uid, item, quantity in added:
                bag[uid] = [item, quantity]
            applied += len(added)
        elif key == keys["inventory_quantity"]:
            change = parse_quantity(body)
            if change and change[0] in bag:
                uid, quantity = change
                if quantity <= 0:
                    del bag[uid]
                else:
                    bag[uid][1] = quantity
                applied += 1
        elif key == keys["inventory_remove"]:
            uid = parse_remove(body)
            # A removal names a uid from anywhere, not only the bags -- the
            # message is a bare id and the game uses it broadly. Only the ones
            # that were in the bag count.
            if uid in bag:
                del bag[uid]
                applied += 1
    print("  %d change(s) after it, %d applied -- %d slot(s), %d unit(s)"
          % (len(changes), applied, len(bag), sum(q for _i, q in bag.values())))

    stacked = sorted(((u, i, q) for u, (i, q) in bag.items() if q > 1),
                     key=lambda r: -r[2])
    for uid, item, quantity in stacked[:8]:
        name = psql("SELECT coalesce(name_fr,'?') FROM items WHERE item_id = %d" % item,
                    rows=True)
        print("    %-8d x%-5d %s" % (item, quantity, name[0][0] if name else "?"))
    if args.dry_run:
        return

    values = ",\n  ".join("(%d,%d,%d)" % (u, i, q) for u, (i, q) in sorted(bag.items()))
    # Replace, do not merge: the listing is the whole bag, so a row it does not
    # mention is an item that is no longer there.
    psql("BEGIN;\nDELETE FROM inventory;\n"
         "INSERT INTO inventory (uid, item_id, quantity)\nVALUES\n  " + values +
         "\nON CONFLICT (uid) DO UPDATE SET item_id = EXCLUDED.item_id,"
         " quantity = EXCLUDED.quantity, seen_at = now();\nCOMMIT;\n")
    print("  wrote %d row(s)" % len(bag))


if __name__ == "__main__":
    main()
