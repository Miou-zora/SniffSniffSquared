# CLAUDE.md

Passive sniffer for Dofus 3 (Unity / IL2CPP, `Ankama.SpinConnection`). Reads
TCP off the wire with pcap, reassembles, deframes, decodes protobuf, and
writes selected messages to Postgres.

Read `RUNBOOK.md` before doing protocol work — it has the full pipeline
explanation, the verified command sequence, and a "dead ends" list.

## Ground truth, so you don't re-derive it

- **The traffic is NOT encrypted.** Plaintext protobuf on TCP 5555. If output
  looks like noise it is a decode bug or a mis-joined schema, never a cipher.
  Confirm with `--raw` — you will see `type.ankama.com/...` in ASCII.
- **Messages are keyed by the `Any` type URL** (`type.ankama.com/ksv`), not by
  `Frame.Payload.id`. The `id` map is not used anywhere in `src/`. Do not
  chase it.
- **Field names are unknown** for the game protocol. `proto/messages.json`
  carries field numbers and C# types only.
- **`proto/messages.json` is frequently mis-joined to the wire.** It is keyed
  by obfuscated C# class path; the join to the `Any` key is a guess and is
  wrong for roughly 4 of 6 observed keys. `src/dump.rs` detects and flags this
  rather than trusting it.

## Layout

```
src/            Rust sniffer (see module table in RUNBOOK.md part 1)
proto/          messages.json (schema registry) + generated dofus3.proto
tools/          gen_proto.py, parse_descriptors.py, replay.py,
                resign-debug-app.sh
tools/frida/    runtime schema extraction: agent.ts, probe.ts, run.py
docs/           observations.md — annotated real captures
reference/      il2cpp-dump-20260710/, Mapping.v2*.json (inputs to gen_proto.py)
RUNBOOK.md      the guide. Start here for anything protocol-related.
```

## Commands

```sh
cargo build && cargo test                 # 10 tests
docker compose up -d                      # postgres + pgadmin
./target/debug/SniffSniffSquared --dev en0 --all "tcp port 5555"
./target/debug/SniffSniffSquared --dev en0 --raw "tcp port 5555"
./target/debug/SniffSniffSquared --list
docker exec dofus_db psql -U dofus -d dofus -c '\dt'
```

## Traps that have already cost time

- **`cargo test` does not rebuild `target/debug/SniffSniffSquared`.** Run
  `cargo build` before capturing, or you will analyse output from a stale
  binary and reach wrong conclusions. This happened.
- **`.env` needs `BPF_FILTER` quoted.** `BPF_FILTER=tcp port 5555` unquoted
  makes `dotenvy` stop parsing at the space, so `DATABASE_URL` (declared
  later) silently never loads and the sniffer runs with no DB and no error.
  Symptom: no `[db] connected` line and no failure message either.
- **No sudo needed for capture** if the user is in `access_bpf` (they are).
- **Frida cannot attach to the shipped client.** Hardened runtime without
  `get-task-allow`; SIP blocks root too. Use `tools/resign-debug-app.sh`,
  which re-signs a *copy*. Never modify the real install.
- **The Frida scan freezes the client** at 100%+ CPU on its own threads for
  the entire run, and it will not quit. Only run it against the re-signed
  copy, never a client being played. Abort = kill `run.py`, then the game pid.
- **Never look up `get_Descriptor` / `get_Parser` by name** in the game
  protocol assembly — they are obfuscated (`ksv` exposes them as `coma` /
  `colz`). Name lookup finds *zero* messages while appearing to work, because
  the unobfuscated chat-service assembly still matches. Match on signature:
  static, zero-arg, returns `MessageDescriptor`.
- **`esg` is no longer the wire-id class** in the current build. The `esg` and
  RVA `0x1AF2A50` references in `tools/frida/README.md` are stale.
- **Long-running background commands: don't pipe through `grep` without
  `--line-buffered`,** or progress output is invisible until exit. And
  `pgrep -f` matches the shell wrapper, so it reports "running" for a process
  that already died — check CPU time, not just existence.

## Conventions

- Rust: no `unwrap()` on wire data — everything from the network is
  `Option`/`Result` and falls back to a heuristic. Match the existing terse
  doc-comment style (`//!` module header explaining *why*, not *what*).
- When schema and wire disagree, **prefer the wire and flag it**. A wrong
  schema is worse than no schema — it forces strings through the packed-int
  path and prints digit soup. See the `MISMATCH` tag in `src/dump.rs`.
- New message support goes in two places: an interpreter arm in
  `src/interpret.rs` (plus `is_known_key`), and optionally a handler in
  `build_dispatch()` in `src/main.rs` to persist it.
- Test fixtures in `src/dump.rs` and `src/dispatch.rs` are **real captured
  bytes**. Keep them byte-exact.

## State of play

Working: capture, reassembly, adaptive deframing, `Any` unwrapping,
schema-vs-wire mismatch detection, signed-varint decoding, `kdh` → Postgres.

Partly done: runtime schema extraction works and is proven end-to-end —
`agent.ts` pulls each `.proto` file's serialized `FileDescriptorProto`,
`tools/parse_descriptors.py` turns it into `proto/messages.runtime.json` keyed
by protobuf `FullName` (the same token the wire uses). 51 chat-service messages
recovered with real field names. **But the scan stops before reaching
`Ankama.Dofus.Protocol.Game`**, so the messages that matter are still missing;
nothing consumes `messages.runtime.json` yet.

The blocker is diagnosed: invoking the descriptor getter on any
`Ankama.Dofus.Protocol.Game` class deadlocks (process goes idle). Nine
approaches already ruled out — read the table in `RUNBOOK.md` part 3 before
trying anything. **Diagnostics must use `send()`, not `console.log`**: agent
`console.log` is queued until the script yields, which makes a working scan
and a hung one look identical.

Done since: the `packets` table now archives every message via
`Dispatcher::on_any` (`ARCHIVE_PACKETS=0` disables), and `tools/replay.py`
exercises the whole pipeline over loopback so the client is not needed to test.

Not done: nothing consumes `messages.runtime.json`; the `decoded` column stays
NULL. `dump.cs` is gitignored (64 MB) — extract it from the Il2CppDumper zip to
use `gen_proto.py`. Details in `RUNBOOK.md` part 3.
