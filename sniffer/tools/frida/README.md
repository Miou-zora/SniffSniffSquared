# Recovering real names + wire ids (build-exact)

Two routes. Prefer **A (Frida)** — it reads the live client and gets real message
names, real field names, field numbers, and the wire id map in one pass. Use
**B (Ghidra)** only if you can't run the client.

## A. Frida (runtime, recommended)

Needs the client running on the same machine.

```sh
cd tools/frida
npm init -y
npm i frida-il2cpp-bridge
npx frida-compile agent.ts -o agent.js
# attach to the running game:
frida -U -n Dofus -l agent.js
# or spawn it:
frida -U -f com.ankama.dofus -l agent.js --no-pause
```

Output: `/tmp/dofus_protocol.json`

```jsonc
{
  "messages": {
    "com.ankama.dofus.server.connection.protocol.TokenRequest": {
      "obf": "lee",
      "id": 1234,                       // present if in the esg map
      "fields": [ { "name": "...", "number": 1, "type": "bytes", "repeated": false, "map": false } ]
    }
  },
  "idMap": { "com.ankama...TokenRequest": 1234 }
}
```

macOS notes: Frida on Apple Silicon needs the game unsigned-debuggable or
`frida-server`/entitlements; attaching to your own launched process is simplest.
If a call throws `no such method/field`, check the three `(VERIFY)` spots in
`agent.ts` (bridge API names drift across versions).

## B. Ghidra (static, offline)

1. Load `GameAssembly.dylib` into Ghidra, auto-analyze.
2. Run Il2CppDumper's `ghidra.py` (ships beside `dump.cs`) to apply symbols.
3. Script Manager → run `ghidra_dump_esg.py`.

Output: `/tmp/esg_idmap.json` (id → obfuscated type) + `/tmp/esg_cctor.c` (raw
decompilation to eyeball if the regex misses). Ghidra gives ids keyed by
obfuscated type; join with `Mapping.v2*.json` or route A's `messages[*].obf`
to get real names.

## Combine into the decoder

`../gen_proto.py` already emits build-exact field numbers/types keyed by
obfuscated names. Route A's JSON supplies the correct real names + the `id`s.
Join them to produce: `wire id -> real message name -> prost struct`.
That closes the pipeline:

    TCP -> FrameDelimiter -> SpinTransportLayer -> Frame -> Payload{id,data}
        -> idMap[id] -> parse data with the matching prost message
