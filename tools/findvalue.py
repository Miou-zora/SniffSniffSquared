#!/usr/bin/env python3
"""
Find which captured message carries a set of values you can see in game.

Known-plaintext identification. Read some numbers off the screen (item prices,
quantities, a character id, kamas), pass them in, and this searches every
archived message body for those values encoded as protobuf varints. A message
containing several of your numbers at once is the one that carries them.

This beats action-correlation (tools/identify.py) when you can read exact
values, because it identifies the *field* as well as the message, and it works
on traffic already captured.

Usage:
    tools/findvalue.py 394 1989 24996
    tools/findvalue.py --since '10 minutes' 1250 8400
    tools/findvalue.py --key ksv 12345

A single small number matches noise everywhere -- one-byte varints appear in
almost every message. Pass three or more values from the same screen and rank
by how many co-occur; that is what makes the result trustworthy.
"""
import argparse
import subprocess
import sys
from collections import defaultdict

PSQL = ["docker", "exec", "dofus_db", "psql", "-U", "dofus", "-d", "dofus",
        "-t", "-A", "-F", "\t", "-c"]


def varint(n):
    """Protobuf base-128 encoding of a non-negative integer."""
    out = bytearray()
    n &= (1 << 64) - 1
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def zigzag(n):
    """sint32/sint64 encoding, for values that might be stored signed."""
    return varint((n << 1) ^ (n >> 63) if n < 0 else n << 1)


def fetch(since, key):
    where = ["body IS NOT NULL"]
    if since:
        where.append("captured_at > now() - interval '%s'" % since.replace("'", ""))
    if key:
        where.append("msg_key = '%s'" % key.replace("'", ""))
    sql = ("SELECT id, msg_key, src, dst, encode(body,'hex') FROM packets WHERE %s "
           "ORDER BY id" % " AND ".join(where))
    out = subprocess.run(PSQL + [sql], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("psql failed: %s" % out.stderr.strip())
    rows = []
    for line in out.stdout.strip().splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        pid, mkey, src, dst, hexed = parts[0], parts[1], parts[2], parts[3], parts[4]
        try:
            rows.append((int(pid), mkey, src, dst, bytes.fromhex(hexed)))
        except ValueError:
            continue
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("values", nargs="+", type=int, help="numbers you can see in game")
    ap.add_argument("--since", help="only packets this recent, e.g. '10 minutes'")
    ap.add_argument("--key", help="restrict to one msg_key")
    args = ap.parse_args()

    rows = fetch(args.since, args.key)
    if not rows:
        sys.exit("no packets matched — is the sniffer running and archiving?")
    print("searching %d archived messages for %d values\n" % (len(rows), len(args.values)))

    # encodings to try per value; report which one hit
    enc = {}
    for v in args.values:
        enc[v] = [("varint", varint(v))]
        if v >= 0:
            z = zigzag(v)
            if z != varint(v):
                enc[v].append(("zigzag", z))

    hits = []           # (n_matched, pid, key, direction, matched detail)
    per_key = defaultdict(set)
    for pid, mkey, src, dst, body in rows:
        found = []
        for v, forms in enc.items():
            for name, pat in forms:
                if pat in body:
                    found.append((v, name))
                    break
        if found:
            direction = "S->C" if src.endswith(":5555") else "C->S"
            hits.append((len(found), pid, mkey, direction, found, len(body)))
            per_key[mkey].add(len(found))

    if not hits:
        print("no message contains any of those values.")
        print("Ideas: the value may be scaled (x100 for decimals), split across")
        print("fields, or simply not in traffic captured so far.")
        return

    hits.sort(key=lambda h: (-h[0], h[1]))
    best = hits[0][0]

    print("=== best matches (%d of %d values in one message) ===" % (best, len(args.values)))
    for n, pid, mkey, direction, found, blen in hits:
        if n < best:
            break
        vals = ", ".join("%d(%s)" % (v, how) for v, how in found)
        print("  packet #%-6d %-6s %-4s %4dB   %s" % (pid, mkey, direction, blen, vals))

    print("\n=== all keys containing any value ===")
    for mkey in sorted(per_key, key=lambda k: -max(per_key[k])):
        print("  %-6s  best %d/%d values in a single message"
              % (mkey, max(per_key[mkey]), len(args.values)))

    top = hits[0][2]
    print("\nInspect the winner decoded:")
    print("  ./target/debug/SniffSniffSquared --dev en0 --all \"tcp port 5555\"   # watch for %s" % top)
    print("  docker exec dofus_db psql -U dofus -d dofus -c \\")
    print("    \"SELECT encode(body,'hex') FROM packets WHERE id=%d;\"" % hits[0][1])


if __name__ == "__main__":
    main()
