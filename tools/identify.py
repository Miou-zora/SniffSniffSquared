#!/usr/bin/env python3
"""
Identify a message type by correlating it with an in-game action.

The obfuscated `Any` keys rotate between client builds, so a mapping like
"kdh = price list" goes stale. This recovers a mapping empirically and needs
no schema, no client instrumentation, and no Frida: watch the archive while
doing one specific thing in game, and see what shows up that wasn't there
before.

Requires the sniffer running with DATABASE_URL set, so `packets` is filling.

Usage:
    tools/identify.py "open HDV and click an item"
    tools/identify.py --baseline 30 "cast a spell"

It samples a quiet baseline, waits for you to perform the action, then reports
keys that are new or that spiked. Run it a couple of times for the same action
— keys that show up every time are the real match; background chatter varies.
"""
import argparse
import os
import subprocess
import sys
import time
from collections import Counter

PSQL = ["docker", "exec", "dofus_db", "psql", "-U", "dofus", "-d", "dofus", "-t", "-A", "-F", "\t", "-c"]


def counts_since(seconds):
    """msg_key -> count over the last `seconds` seconds."""
    sql = (
        "SELECT msg_key, count(*) FROM packets "
        "WHERE captured_at > now() - interval '%d seconds' "
        "AND msg_key IS NOT NULL GROUP BY 1" % seconds
    )
    out = subprocess.run(PSQL + [sql], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("psql failed: %s" % out.stderr.strip())
    c = Counter()
    for line in out.stdout.strip().splitlines():
        if not line.strip():
            continue
        key, n = line.split("\t")
        c[key] = int(n)
    return c


def total(c):
    return sum(c.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", help="what you will do in game, for the report")
    ap.add_argument("--baseline", type=int, default=20, help="baseline sample seconds (default 20)")
    args = ap.parse_args()

    print("Stand still and do nothing for %ds while I sample the background..." % args.baseline)
    time.sleep(args.baseline)
    base = counts_since(args.baseline)
    if not total(base):
        sys.exit("no packets arrived — is the sniffer running with DATABASE_URL set?")
    print("  baseline: %d messages, %d distinct keys" % (total(base), len(base)))

    input('\nNow DO THE ACTION: "%s"\nPress Enter the moment you are done... ' % args.action)
    # measure only the window since the prompt
    t0 = time.time()
    time.sleep(2)  # let the last packets land
    window = counts_since(int(time.time() - t0) + 3)

    if not total(window):
        sys.exit("nothing captured during the action — did the sniffer stay running?")

    # per-second rates, so a short action is comparable to a long baseline
    base_rate = {k: v / args.baseline for k, v in base.items()}
    span = max(int(time.time() - t0) + 3, 1)
    win_rate = {k: v / span for k, v in window.items()}

    new = [k for k in win_rate if k not in base_rate]
    spiked = [
        k for k in win_rate
        if k in base_rate and base_rate[k] > 0 and win_rate[k] > base_rate[k] * 3
    ]

    print("\n=== keys that appeared ONLY during the action ===")
    if new:
        for k in sorted(new, key=lambda k: -window[k]):
            print("  %-6s %d messages   <-- strong candidate" % (k, window[k]))
    else:
        print("  (none)")

    print("\n=== keys that spiked (>3x background rate) ===")
    if spiked:
        for k in sorted(spiked, key=lambda k: -win_rate[k]):
            print("  %-6s %d messages (%.1f/s vs %.2f/s background)"
                  % (k, window[k], win_rate[k], base_rate[k]))
    else:
        print("  (none)")

    print("\nInspect a candidate's payload with:")
    print("  docker exec dofus_db psql -U dofus -d dofus -c \\")
    print("    \"SELECT captured_at, src, vars, packs, encode(body,'hex') FROM packets\"")
    print("    \" WHERE msg_key='<key>' ORDER BY id DESC LIMIT 5;\"")
    print("\nNote: vars/packs come from the schema registry, which is mis-keyed for")
    print("this build. Trust `body`; decode it with --all on a live capture.")


if __name__ == "__main__":
    main()
