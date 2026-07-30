#!/usr/bin/env python3
"""
Reconstruct .proto schemas for the Dofus 3 (Unity) network protocol from an
Il2CppDumper dump.cs plus the deobfuscation Mapping.v2*.json files.

- Message field NUMBERS come from `public const int <tok> = <N>;`
- Message field TYPES come from the value properties (in the same source order).
- Class names are deobfuscated via the Mapping files (keyed by the leaf token).

Nesting in the obfuscated dump does NOT match the real nesting, so every message
is emitted FLAT as a top-level proto message named after its real dotted path
(dots -> underscores). This is wire-compatible: only field number + wire type
matter for decoding.

NOT recovered here (needs the binary / runtime, not dump.cs):
  * the Payload.id <-> message-type numeric map  (class `esg`, .cctor RVA 0x1AF2A50)
  * the FrameDelimiter length-header width / SpinTransportLayer byte layout
"""
import json, re, sys, os
from collections import OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, "reference")
# NOTE: dump.cs is NOT committed (70 MB+). Regenerate it with Il2CppDumper
# against the current GameAssembly.dylib + global-metadata.dat. See RUNBOOK.md
# part 3 — the committed proto/messages.json came from the 2026-07-10 dump and
# the client has updated since.
DUMP = os.path.join(REF, "il2cpp-dump-20260710", "dump.cs")
MAPPINGS = [os.path.join(REF, "Mapping.v2.json"), os.path.join(REF, "Mapping.v2-2.json")]
OUTDIR = os.path.join(ROOT, "proto")

SCALAR = {
    "int": "int32", "uint": "uint32", "long": "int64", "ulong": "uint64",
    "bool": "bool", "float": "float", "double": "double",
    "string": "string", "ByteString": "bytes",
    "sbyte": "int32", "byte": "uint32", "short": "int32", "ushort": "uint32",
    "char": "uint32",
}

DECL_RE  = re.compile(r'^\s*(?:\[[^\]]*\]\s*)*(?:public |internal |private |protected |sealed |abstract |static )*(class|struct|enum)\s+(\S+)\s.*//\s*TypeDefIndex:')
CONST_RE = re.compile(r'^\s*public const int \w+ = (-?\d+);')
PROP_RE  = re.compile(r'^\s*public ([A-Za-z0-9_.`<>,\[\]? ]+?) [A-Za-z_]\w* \{ get;( set;)? \}')


def load_mappings():
    obf2real = {}
    for p in MAPPINGS:
        with open(p, encoding="utf-8") as f:
            obf2real.update(json.load(f))
    return obf2real


def leaf(path):
    # last dotted segment, drop generic backticks
    return path.split("`")[0].split(".")[-1]


def iter_type_blocks(lines):
    """Yield (kind, path, body_lines). Blocks in the dump are textually flat."""
    i, n = 0, len(lines)
    while i < n:
        m = DECL_RE.match(lines[i])
        if not m:
            i += 1
            continue
        kind, path = m.group(1), m.group(2)
        # find opening brace
        j = i + 1
        while j < n and "{" not in lines[j]:
            if DECL_RE.match(lines[j]):  # no body (shouldn't happen)
                break
            j += 1
        if j >= n or "{" not in lines[j]:
            i += 1
            continue
        depth = 0
        body = []
        k = j
        while k < n:
            depth += lines[k].count("{") - lines[k].count("}")
            body.append(lines[k])
            if depth <= 0:
                break
            k += 1
        yield kind, path, body
        i = k + 1


def main():
    if not os.path.exists(DUMP):
        sys.exit(
            "dump.cs not found at %s\n"
            "It is not committed (too large). Regenerate it with Il2CppDumper against\n"
            "  /Applications/Ankama/Dofus-dofus3/Dofus.app/Contents/Frameworks/GameAssembly.dylib\n"
            "  .../Contents/Resources/Data/il2cpp_data/Metadata/global-metadata.dat\n"
            "then drop dump.cs beside the DummyDll/ folder. See RUNBOOK.md part 3." % DUMP
        )
    obf2real = load_mappings()
    with open(DUMP, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()

    messages = OrderedDict()   # path -> {real, nums, types}
    enums = set()              # leaf tokens that are enums
    raw_msgs = []              # (path, body) stashed for a second pass

    # pass 1: collect enum leaves + stash message blocks
    for kind, path, body in iter_type_blocks(lines):
        if kind == "enum":
            enums.add(leaf(path))
            continue
        text = "".join(body)
        if "MessageParser<" not in text or '[GeneratedCode("protoc"' not in text:
            continue
        if ("MessageParser<%s>" % path) not in text:  # must own its parser
            continue
        raw_msgs.append((path, body))

    # pass 2: extract fields now that `enums` is complete
    for path, body in raw_msgs:
        nums, types = [], []
        for ln in body:
            cm = CONST_RE.match(ln)
            if cm:
                nums.append(int(cm.group(1)))
                continue
            pm = PROP_RE.match(ln)
            if pm:
                t = pm.group(1).strip()
                get_only = pm.group(2) is None
                if t.startswith("static ") or "MessageParser" in t or t == "MessageDescriptor" or t.endswith("OneofCase"):
                    continue
                # get-only bool = proto3 optional Has-flag; get-only enum = oneof case selector
                if get_only and (t == "bool" or leaf(t) in enums):
                    continue
                types.append(t)
        messages[path] = {"real": obf2real.get(leaf(path)), "nums": nums, "types": types}

    msg_leaves = {leaf(p) for p in messages}

    def sanitize(name):
        return re.sub(r'[^0-9A-Za-z_]', '_', name)

    def proto_name(path):
        real = obf2real.get(leaf(path))
        return sanitize(real) if real else sanitize(path)

    def resolve(t):
        """return (proto_type_str, is_repeated)."""
        t = t.strip()
        if t in SCALAR:
            return SCALAR[t], False
        rf = re.match(r'RepeatedField<(.+)>$', t)
        if rf:
            inner, _ = resolve(rf.group(1))
            return inner, True
        mf = re.match(r'MapField<([^,]+),\s*(.+)>$', t)
        if mf:
            k = SCALAR.get(mf.group(1).strip(), "int64")
            v, _ = resolve(mf.group(2))
            return "map<%s, %s>" % (k, v), False
        nl = re.match(r'Nullable<(.+)>$', t)
        if nl:
            return resolve(nl.group(1))
        lf = leaf(t)
        if lf in msg_leaves:
            return sanitize(obf2real.get(lf, t)), False
        if lf in enums:
            return "int32", False  # enums are varint; decode as int32
        # unknown reference -> keep as int32 fallback (most are enums)
        return "int32", False

    os.makedirs(OUTDIR, exist_ok=True)
    out = os.path.join(OUTDIR, "dofus3.proto")
    warn = []
    with open(out, "w", encoding="utf-8") as w:
        w.write('syntax = "proto3";\n\n')
        w.write('// Auto-generated from dump.cs + Mapping.v2*.json by tools/gen_proto.py\n')
        w.write('// RELIABLE: field NUMBERS + wire TYPES (extracted from THIS dump build).\n')
        w.write('// BEST-EFFORT ONLY: the "real:" names below come from Mapping.v2*.json,\n')
        w.write('//   which does NOT fully match this build (>=46 message names map to leaves\n')
        w.write('//   that are enums here). Treat obf names + numbers as ground truth; verify\n')
        w.write('//   real names against global-metadata.dat before trusting them.\n')
        w.write('// Field names are unknown (obfuscated); only numbers + types are recovered.\n\n')
        # transport envelope (hand-known, not obfuscated)
        w.write("message Frame {\n")
        w.write("  message Payload  { int32 id = 1; bytes data = 2; }\n")
        w.write("  message Request  { int32 correlation_id = 1; Payload payload = 2; }\n")
        w.write("  message Response { int32 correlation_id = 1; int32 status = 2; Payload payload = 3; }\n")
        w.write("  oneof content { Request request = 1; Response response = 2; Payload event = 3; }\n")
        w.write("}\n\n")
        for path, info in messages.items():
            nums, types = info["nums"], info["types"]
            name = proto_name(path)
            w.write("message %s {\n" % name)
            w.write("  // obf: %s%s\n" % (path, "" if info["real"] else "  (UNMAPPED)"))
            if info["real"]:
                w.write("  // real: %s\n" % info["real"])
            pairs = list(zip(nums, types))
            if len(nums) != len(types):
                warn.append("%s: %d numbers vs %d types" % (path, len(nums), len(types)))
            for num, t in pairs:
                pt, rep = resolve(t)
                if pt.startswith("map<"):
                    w.write("  %s f_%d = %d;\n" % (pt, num, num))
                else:
                    w.write("  %s%s f_%d = %d;\n" % ("repeated " if rep else "", pt, num, num))
            w.write("}\n\n")

    # machine-readable sidecar
    side = os.path.join(OUTDIR, "messages.json")
    with open(side, "w", encoding="utf-8") as w:
        json.dump({p: {"real": i["real"],
                       "fields": [{"num": n, "csharp": t} for n, t in zip(i["nums"], i["types"])]}
                   for p, i in messages.items()}, w, indent=1)

    print("messages parsed:", len(messages))
    print("  mapped:", sum(1 for i in messages.values() if i["real"]))
    print("  unmapped:", sum(1 for i in messages.values() if not i["real"]))
    print("enums seen:", len(enums))
    print("field-count mismatches:", len(warn))
    for x in warn[:15]:
        print("   ", x)
    print("wrote:", out)
    print("wrote:", side)


if __name__ == "__main__":
    main()
