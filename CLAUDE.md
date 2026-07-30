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
- **The obfuscated `Any` keys ROTATE between client builds.** `kdh`, `kag` and
  `jqj` — the keys the older notes are written around — do not exist in the
  current build at all; an 861-message capture contains none of them (`ksv`
  survived). Any "key X means Y" mapping is only valid for the build it was
  observed on. Re-identify with `tools/identify.py` rather than trusting notes.
- **Messages are keyed by the `Any` type URL** (`type.ankama.com/ksv`), not by
  `Frame.Payload.id`. The `id` map is not used anywhere in `src/`. Do not
  chase it.
- **Field names are unknown** for the game protocol. `proto/messages.json`
  carries field numbers and C# types only, and it is keyed by the 2026-07-10
  build's obfuscated names — which the current wire no longer uses. Treat
  `vars`/`packs` in the `packets` table as unreliable for that reason; `body`
  is the ground truth.
- **`proto/messages.json` is frequently mis-joined to the wire** — measured
  wrong for 4 of 6 keys observed at the time. Two causes, and key rotation
  (above) is the bigger one: the registry describes a build whose keys the wire
  no longer uses, so a name that still resolves may now describe a completely
  different message. `src/dump.rs` detects and flags the disagreement rather
  than trusting the schema.

## Layout

```
src/            Rust sniffer (see module table in RUNBOOK.md part 1)
proto/          messages.json (schema registry) + generated dofus3.proto
keymap.json  wire-key overrides — edit when a build rotates keys
tools/          gen_proto.py, identify.py, findvalue.py,
                parse_descriptors.py, replay.py, resign-debug-app.sh
tools/frida/    runtime schema extraction: agent.ts, probe.ts, run.py
docs/           observations.md — annotated real captures
reference/      il2cpp-dump-20260710/, Mapping.v2*.json (inputs to gen_proto.py)
RUNBOOK.md      the guide. Start here for anything protocol-related.
```

## Commands

```sh
cargo build && cargo test                 # 18 tests
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
- **Frida attachment eventually CRASHES the client.** Not just freezes it: the
  injected thread breaks C++ exception unwinding, so the next managed exception
  IL2CPP throws segfaults the process (`_Unwind_RaiseException` -> bad PC).
  Confirmed on a logged-in session that died mid-play. Never attach to a client
  anyone is using. Abort = kill `run.py`, then the game pid.
- **The re-signed copy needs Zaap's launch arguments**, not just the right
  directory: `--port`, `--hash` (per-launch session uuid), `--instanceId`,
  `--connectionPort`. Grab them from a live launcher-started client (see
  RUNBOOK part 3) and use a different `--instanceId`/`--logfile` so it runs
  alongside the real client. The hash works concurrently.
- **The re-signed copy MUST be launched from `/Applications/Ankama/Dofus-dofus3`.**
  Addressables catalogs resolve relative to the launch directory; run it from
  anywhere else and it fails at boot (`Unable to find catalog list`) while
  still opening a window, so it looks alive but no per-frame code ever runs.
  Verify with `grep -c "Unable to find catalog list" ~/Library/Logs/Ankama/Dofus/Player.log`
  before trusting any scan result.
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
schema-vs-wire mismatch detection, signed-varint decoding, every message
archived to `packets`. 94 distinct message keys observed in one session.

**Messages are referred to by semantic name, never by wire key.** `src/messages.rs`
owns the `name <-> key` mapping and is the only place a rotated key changes;
`keymap.json` overrides it at runtime with no rebuild. Adding a message:
name it in `messages::DEFAULTS`, parse it in `interpret.rs` matching on the
*name*, optionally persist it in `build_dispatch()` via
`messages::keymap().key("...")`, and pin it with a test over real bytes.
`price_list` is the worked example.

| semantic name | key (this build) | meaning |
|---|---|---|
| `price_list` | `kea` | marketplace ladder x1/x10/x100/x1000 -> `prices` table |
| `chat_message` | `ksv` | chat/trade channel |
| `price_list_legacy` | `kdh` | the 2026-07-10 price list; gone from the wire, kept for tests |

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
