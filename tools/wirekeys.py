#!/usr/bin/env python3
"""
Semantic message name -> obfuscated wire key, for the Python tools.

The keys rotate between client builds, and `sniffer/src/messages.rs` DEFAULTS is
where the current set lives. `sniffer/keymap.json` is empty on purpose: it holds
only what has moved *past* those defaults, so the two can never drift.

Every tool in here used to carry its own hardcoded fallback instead — a private
copy of the defaults that nothing updates. After the 2026-08-04 rotation all four
were still scanning for `kea` / `kfy` / `kev` / `iss`, matched nothing, and
reported it as "0 messages" rather than as a failure. This module exists so
there is exactly one copy of that mapping on the Python side, and it is the same
one the sniffer compiles in.

Resolution order is the sniffer's own: keymap.json wins, then the Rust DEFAULTS.
There is deliberately no third fallback — an unresolvable name raises, because a
stale key is worse than no key. `iun` is the standing example: it survived the
rotation carrying a *different* message (pods, `{1: current weight, 3: max}`), so
a tool left pointing at it parses pods as inventory additions and writes nonsense
instead of failing.

All three files are read once per process and cached. The parsers call in per
message, so an uncached read meant reopening schema.json thousands of times for
one backfill. Editing a file mid-run therefore has no effect — these are
one-shot CLI tools, and the sniffer, which does need a live reload, has its own.
"""
import functools
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MESSAGES_RS = os.path.join(ROOT, "sniffer", "src", "messages.rs")
KEYMAP = os.path.join(ROOT, "sniffer", "keymap.json")
SCHEMA = os.path.join(ROOT, "sniffer", "schema.json")

# ("price_list", "kbt") — the entries of the DEFAULTS table, comments and all.
_ENTRY = re.compile(r'\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*"([A-Za-z0-9_]+)"\s*\)')


@functools.lru_cache(maxsize=1)
def _defaults():
    """Parse messages.rs once per process. See defaults()."""
    with open(MESSAGES_RS, encoding="utf-8") as fh:
        src = fh.read()
    start = src.index("pub const DEFAULTS")
    body = src[start:src.index("];", start)]
    out = dict(_ENTRY.findall(body))
    if not out:
        raise RuntimeError(
            "no entries parsed out of %s — has the DEFAULTS table changed shape?"
            % MESSAGES_RS)
    return out


def defaults():
    """The `DEFAULTS` table out of messages.rs, as {name: key}.

    Parsed rather than duplicated. Reading the Rust is ugly, but it is the only
    way for a Python tool to stay correct across a rotation without a second
    copy someone has to remember to update — which is the bug this replaces.

    A copy of the cached parse: the parsers below call this per message, and
    keys() mutates what it gets back.
    """
    return dict(_defaults())


@functools.lru_cache(maxsize=1)
def _overrides():
    """Read keymap.json once per process. See overrides()."""
    try:
        with open(KEYMAP, encoding="utf-8") as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        # Not fatal by itself, but it means an intended override is not applied.
        print("  ! could not read %s (%s); using the Rust defaults alone"
              % (KEYMAP, e))
        return {}
    return {k: v for k, v in raw.items() if not k.startswith("_") and v}


def overrides():
    """keymap.json, minus its `_`-prefixed comment keys. Missing file is fine —
    empty is its normal state. A copy, for the same reason defaults() copies."""
    return dict(_overrides())


def key(name):
    """Wire key for a semantic name. Raises if the name is unknown — see above."""
    return keys(name)[name]


def keys(*names):
    """Resolve several names at once: {name: key}."""
    table = defaults()
    table.update(overrides())
    missing = [n for n in names if n not in table]
    if missing:
        raise KeyError(
            "no wire key for %s. Known names: %s. Add it to DEFAULTS in %s, or "
            "override it in %s." % (", ".join(missing), ", ".join(sorted(table)),
                                    MESSAGES_RS, KEYMAP))
    return {n: table[n] for n in names}


@functools.lru_cache(maxsize=1)
def _shapes():
    """Read schema.json once per process. See field_numbers()."""
    with open(SCHEMA, encoding="utf-8") as fh:
        return json.load(fh)


def field_numbers(message):
    """{field name: number} for one message shape in sniffer/schema.json.

    Shapes belong next to the keys because they rotate on the same schedule: the
    2026-08-04 update moved a field number in every message the sniffer reads
    except crush_slot_put. A Python parser with the numbers written into it goes
    stale silently, and item_detail is the worst case — `uid` and `item_id`
    swapped places between builds, and both are varints, so the old numbers over
    new bytes decode without complaint into an item with its two identifiers
    exchanged.
    """
    shapes = _shapes()
    shape = shapes.get(message)
    if not shape:
        raise KeyError("no shape for %s in %s. Known: %s"
                       % (message, SCHEMA,
                          ", ".join(k for k in shapes if not k.startswith("_"))))
    return {f["name"]: f["n"] for f in shape["fields"]}


def explain_empty_scan(name, wire_key, psql):
    """Say why a scan matched nothing, when it might be a rotated key.

    A stale key and an empty capture produce the identical "0 messages" line,
    and telling them apart by eye is what nobody did for a month. `psql` is the
    caller's own query helper, called as psql(sql, rows=True).
    """
    total = psql("SELECT count(*) FROM packets", rows=True)
    total = int(total[0][0]) if total else 0
    if total == 0:
        print("  the `packets` table is empty — nothing has been captured yet.")
        return
    print("  ! %s (%s) matched none of the %d archived packets."
          % (name, wire_key, total))
    top = psql(
        "SELECT msg_key, count(*) FROM packets WHERE msg_key IS NOT NULL "
        "GROUP BY 1 ORDER BY 2 DESC LIMIT 8", rows=True)
    if top:
        print("    the archive's most common keys are: %s"
              % ", ".join("%s x%s" % (k, n) for k, n in top))
    print("    if the client updated, the key rotated: re-identify it with "
          "sniffer/tools/identify.py and put it in sniffer/keymap.json.")


if __name__ == "__main__":
    # `tools/wirekeys.py` on its own prints what the Python tools resolve today,
    # which is the fastest way to check them against a fresh capture.
    table = defaults()
    over = overrides()
    table.update(over)
    for n, k in sorted(table.items()):
        print("%-20s %s%s" % (n, k, "   (keymap.json)" if n in over else ""))
