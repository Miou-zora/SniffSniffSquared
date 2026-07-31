#!/usr/bin/env python3
"""
Check the brisage model against every crush in the capture.

Pulls each crush from `packets` — the item's stats from `item_detail`, the
coefficient and rune counts from `crush_result`, the focus from
`crush_request` — resolves rune weights from the `runes` table and item levels
from DofusDB, then prints predicted against actual.

For focused crushes it prints several candidate formulas side by side, because
which one is right is still open. See docs/brisage-model.md.

    tools/check_brisage.py              # every crush found
    tools/check_brisage.py --since 8674 # only packets after this id

Needs the db container running, the `runes` table loaded
(tools/import_runes.py) and `requests`.
"""
import argparse
import json
import subprocess
import sys

API_ITEM = "https://api.dofusdb.fr/items/"


def psql(sql):
    out = subprocess.run(
        ["docker", "exec", "dofus_db", "psql", "-U", "dofus", "-d", "dofus",
         "-t", "-A", "-F", "\t", "-c", sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit("psql failed: " + out.stderr.strip())
    return [l.split("\t") for l in out.stdout.strip().split("\n") if l.strip()]


def varint(b, i):
    r = s = 0
    while i < len(b):
        c = b[i]; i += 1
        r |= (c & 0x7F) << s
        if not c & 0x80:
            return r, i
        s += 7
    raise ValueError


def walk(b, path=()):
    """Flatten a protobuf message to (field path, varint value) pairs."""
    i, out = 0, []
    while i < len(b):
        try:
            key, i = varint(b, i)
        except ValueError:
            break
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = varint(b, i); out.append((path + (f,), v))
        elif wt == 2:
            n, i = varint(b, i); out += walk(b[i:i + n], path + (f,)); i += n
        elif wt == 5:
            i += 4
        elif wt == 1:
            i += 8
        else:
            break
    return out


def item_stats(body):
    """[(effect_id, value)] from an item_detail message."""
    out, cur = [], None
    for p, v in walk(body):
        if len(p) >= 2 and p[-1] == 8 and p[-2] == 5:
            cur = v
        elif len(p) >= 2 and p[-1] == 9 and cur is not None:
            out.append((v, cur)); cur = None
    return out


def levels(item_ids):
    import requests
    out = {}
    for i in item_ids:
        try:
            r = requests.get(API_ITEM + str(i), timeout=20)
            r.raise_for_status()
            d = r.json()
            out[i] = (d.get("level"), (d.get("name") or {}).get("fr", "?"))
        except Exception:
            out[i] = (None, "?")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=0, help="only packets after this id")
    args = ap.parse_args()

    weights = {}
    for eff, rune, w, spr, item in psql(
        "SELECT effect_id, rune, rune_weight, stat_per_rune, COALESCE(item_id,0) "
        "FROM runes WHERE effect_id IS NOT NULL"
    ):
        weights[int(eff)] = {"rune": rune, "w": float(w), "spr": float(spr), "item": int(item)}
    if not weights:
        sys.exit("the `runes` table is empty — run tools/import_runes.py first")

    rows = psql(
        "SELECT id, msg_key, encode(body,'hex') FROM packets "
        "WHERE id > %d AND msg_key IN ('kch','kev','ker','kfy') ORDER BY id" % args.since
    )

    # replay the sequence: placement -> detail -> request(focus) -> result
    details, focus, crushes = {}, None, []
    for pid, key, hexed in rows:
        b = bytes.fromhex(hexed)
        if key == "kev":
            flat = dict(walk(b))
            uid = flat.get((2, 4, 1)); item = flat.get((2, 4, 4))
            if uid and item:
                details[uid] = {"item": item, "stats": item_stats(b)}
        elif key == "ker":
            focus = dict(walk(b)).get((1,))
        elif key == "kfy":
            flat = walk(b)
            uid = dict(flat).get((1, 3))
            coeff = None
            # the yield is a float32, which walk() skips; read it positionally
            i = 0
            runes = []
            cur = {}
            for p, v in flat:
                if p == (1, 1, 1): cur = {"rune": v}
                elif p == (1, 1, 2) and cur: cur["n"] = v; runes.append(cur); cur = {}
            import struct
            # find the i32 right after field 2 inside the wrapper
            for off in range(len(b) - 4):
                if b[off] == 0x15:  # field 2, wire type 5
                    coeff = struct.unpack("<f", b[off + 1:off + 5])[0] * 100
                    break
            crushes.append({"uid": uid, "coeff": coeff, "runes": runes, "focus": focus})
            focus = None

    if not crushes:
        sys.exit("no crushes found in that range")

    ids = {details[c["uid"]]["item"] for c in crushes if c["uid"] in details}
    lv = levels(ids)

    for c in crushes:
        d = details.get(c["uid"])
        if not d:
            print("crush uid %s: no item_detail captured, skipping\n" % c["uid"]); continue
        level, name = lv.get(d["item"], (None, "?"))
        if not level:
            print("crush %s: no level from DofusDB, skipping\n" % name); continue

        lines, unmapped = {}, []
        for eff, val in d["stats"]:
            r = weights.get(eff)
            if not r:
                unmapped.append((eff, val)); continue
            lines[eff] = 3 * val * r["w"] / r["spr"] * level / 200
        total = sum(lines.values())

        print("=== %s (item %s, level %s) — coefficient %.3f%% — focus %s ===" % (
            name, d["item"], level, c["coeff"] or 0, c["focus"] or "none"))
        if unmapped:
            print("    unmapped stats (excluded): %s" % ", ".join(
                "effect %s=%s" % (e, v) for e, v in unmapped))

        actual = {r["rune"]: r["n"] for r in c["runes"]}
        by_item = {v["item"]: (k, v) for k, v in weights.items()}

        if c["focus"] is None:
            print("    %-14s %9s %8s %7s" % ("rune", "predicted", "actual", "diff"))
            for eff, w in sorted(lines.items(), key=lambda x: -x[1]):
                r = weights[eff]
                pred = w / r["w"] * (c["coeff"] / 100)
                act = actual.get(r["item"])
                print("    %-14s %9.2f %8s %7s" % (
                    r["rune"], pred, act if act is not None else "-",
                    "%+.2f" % (pred - act) if act is not None else "-"))
        else:
            eff = c["focus"]
            r = weights.get(eff)
            if not r:
                print("    focus effect %s not in the runes table\n" % eff); continue
            own = lines.get(eff, 0.0)
            act = actual.get(r["item"])
            cands = {
                "sheet   own/2 + total/2": own / 2 + total / 2,
                "excl    own/2 + others/2": own / 2 + (total - own) / 2,
                "full    own + total/2": own + total / 2,
                "others  own + others/2": own + (total - own) / 2,
            }
            print("    focused on %s (weight %g), own line %.2f of total %.2f" % (
                r["rune"], r["w"], own, total))
            print("    actual: %s runes" % act)
            for label, fw in cands.items():
                pred = fw / r["w"] * (c["coeff"] / 100)
                mark = ""
                if act is not None:
                    mark = "  <-- fits" if abs(pred - act) < 0.75 else ""
                print("      %-26s %8.2f%s" % (label, pred, mark))
        print()


if __name__ == "__main__":
    main()
