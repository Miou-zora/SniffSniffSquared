#!/usr/bin/env python3
"""
Turn the Frida dump (/tmp/dofus_protocol.json) into a schema registry.

The agent extracts each loaded .proto file's serialized FileDescriptorProto.
That single blob carries the real message names, real field names, numbers,
types and nesting -- everything proto/messages.json is missing, and it is
build-exact because it came out of the running client.

Unlike gen_proto.py (which reads an Il2CppDumper dump.cs and can only recover
field numbers + C# types keyed by obfuscated class path), this keys messages by
their protobuf FullName -- the same token the wire puts in the `Any` type URL.
That is the join src/registry.rs actually needs.

Usage:
    tools/parse_descriptors.py [IN] [OUT]
Defaults:
    IN   /tmp/dofus_protocol.json
    OUT  proto/messages.runtime.json

Needs the protobuf runtime:  pip install protobuf
"""
import json
import os
import sys

try:
    from google.protobuf import descriptor_pb2
except ImportError:
    sys.exit("needs the protobuf runtime: pip install protobuf")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IN = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dofus_protocol.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "proto", "messages.runtime.json")

# FieldDescriptorProto.Type -> the label src/dump.rs understands. The Rust side
# parses C#-flavoured type names, so emit those rather than proto keywords.
TYPE = {
    1: "double", 2: "float", 3: "long", 4: "ulong", 5: "int",
    6: "ulong", 7: "uint", 8: "bool", 9: "string", 10: "group",
    11: "message", 12: "ByteString", 13: "uint", 14: "enum",
    15: "int", 16: "long", 17: "int", 18: "long",
}


def walk(msg, prefix, out):
    """Emit this DescriptorProto and every message nested inside it."""
    full = "%s.%s" % (prefix, msg.name) if prefix else msg.name
    fields = []
    for f in msg.field:
        base = TYPE.get(f.type, str(f.type))
        if base in ("message", "enum", "group"):
            # type_name is fully qualified with a leading dot
            base = f.type_name.lstrip(".")
        repeated = f.label == 3  # LABEL_REPEATED
        fields.append({
            "num": f.number,
            "name": f.name,
            "csharp": "RepeatedField<%s>" % base if repeated else base,
        })
    out[full] = {"real": full, "fields": fields}
    for nested in msg.nested_type:
        walk(nested, full, out)


def main():
    with open(IN, encoding="utf-8") as fh:
        dump = json.load(fh)

    files = dump.get("files", {})
    if not files:
        sys.exit("%s has no descriptors -- did the scan produce anything?" % IN)

    messages = {}
    for name, hexed in sorted(files.items()):
        fdp = descriptor_pb2.FileDescriptorProto()
        fdp.ParseFromString(bytes.fromhex(hexed))
        pkg = fdp.package
        before = len(messages)
        for msg in fdp.message_type:
            walk(msg, pkg, messages)
        print("  %-28s package=%-20s messages=%d"
              % (name, pkg or "(none)", len(messages) - before))

    # the obfuscated C# class behind each message, when the agent got that far
    class_map = dump.get("classMap", {})
    for full, obf in class_map.items():
        if full in messages:
            messages[full]["obf"] = obf

    with open(OUT, "w", encoding="utf-8") as w:
        json.dump(messages, w, indent=1, sort_keys=True)
    print("\nwrote %s  (%d messages, %d with a C# class mapping)"
          % (OUT, len(messages), sum(1 for m in messages.values() if "obf" in m)))


if __name__ == "__main__":
    main()
