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
  observed on. Re-identify with `sniffer/tools/identify.py` rather than trusting notes.
- **Messages are keyed by the `Any` type URL** (`type.ankama.com/ksv`), not by
  `Frame.Payload.id`. The `id` map is not used anywhere in `sniffer/src/`. Do not
  chase it.
- **Field names are unknown** for the game protocol. `sniffer/proto/messages.json`
  carries field numbers and C# types only, and it is keyed by the 2026-07-10
  build's obfuscated names — which the current wire no longer uses. Treat
  `vars`/`packs` in the `packets` table as unreliable for that reason; `body`
  is the ground truth.
- **`sniffer/proto/messages.json` is frequently mis-joined to the wire** — measured
  wrong for 4 of 6 keys observed at the time. Two causes, and key rotation
  (above) is the bigger one: the registry describes a build whose keys the wire
  no longer uses, so a name that still resolves may now describe a completely
  different message. `sniffer/src/dump.rs` detects and flags the disagreement rather
  than trusting the schema.

## Layout

Monorepo. Shared infra at the root, one folder per app. **The Rust app must be
run from `sniffer/`** (it resolves `keymap.json` and `proto/` relative to cwd).

```
docker-compose.yml  postgres + pgadmin + web; `sniffer` service is Linux-only
init.sql            schema both apps depend on (packets, prices)
docs/               observations.md — annotated real captures
RUNBOOK.md          the guide. Start here for anything protocol-related.

sniffer/            the Rust capture app — RUN IT FROM THIS DIRECTORY
  src/                module table in RUNBOOK.md part 1
  proto/              messages.json (schema registry) + generated dofus3.proto
  keymap.json         wire-key overrides — edit when a build rotates keys
  tools/              gen_proto.py, identify.py, findvalue.py,
                      parse_descriptors.py, replay.py, resign-debug-app.sh
  tools/frida/        runtime schema extraction: agent.ts, probe.ts, run.py
  reference/          il2cpp-dump-20260710/, Mapping.v2*.json (gen_proto inputs)

web/                Next.js 16 front end (scaffolded, no features yet)
  AGENTS.md           the app's own guide; CLAUDE.md just imports it
```

`sniffer/` writes to Postgres, `web/` reads from it — the only coupling.

Item ids are **DofusDB ids** (verified: 2609 = Carapace Verte, typeId 107 =
our decoded category), so `https://api.dofusdb.fr/items/<id>` resolves names,
icons and types with no mapping table. Enrichment happens read-side in `web/`;
the sniffer stays free of network dependencies.

Compose services: `db`, `pgadmin`, `web` start by default; `web-dev` needs
`--profile dev` (hot reload on 3001, via `docker compose watch`); `sniffer`
needs `--profile capture` and only captures on Linux. `watch` does not reliably
start a profile-gated service on its own — `up -d` it first. The production
`web` service is intentionally not watched. Inside compose the database
host is `db`, not `localhost`. For web development prefer `cd web && pnpm dev`
on the host over the container, which serves a production build.

**Working in `web/`: Next 16 differs from training data.** Its `AGENTS.md`
says to read `web/node_modules/next/dist/docs/` before writing code. Do that.
`pnpm check` (typecheck + lint + format) is the gate before committing.

## Commands

The Rust app lives in `sniffer/` and MUST be run from there — it resolves
`keymap.json` and `proto/messages.json` relative to the working directory.

```sh
docker compose up -d                      # postgres + pgadmin, from repo root
cd sniffer
cargo build && cargo test                 # 19 tests
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
- **The compose `sniffer` service cannot capture on macOS.** Docker's "host"
  network is the Linux VM, not the Mac: the container sees `eth0`/`docker0`,
  never `en0`, and silently captures nothing. It is behind a `capture` profile
  so it does not start by default. On macOS run the binary natively. The image
  itself is fine — it builds, loads keymap + registry, and reaches Postgres.
- **Frida cannot attach to the shipped client.** Hardened runtime without
  `get-task-allow`; SIP blocks root too. Use `sniffer/tools/resign-debug-app.sh`,
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
  RVA `0x1AF2A50` references in `sniffer/tools/frida/README.md` are stale.
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
  path and prints digit soup. See the `MISMATCH` tag in `sniffer/src/dump.rs`.
- New message support goes in two places: an interpreter arm in
  `sniffer/src/interpret.rs` (plus `is_known_key`), and optionally a handler in
  `build_dispatch()` in `sniffer/src/main.rs` to persist it.
- Test fixtures in `sniffer/src/dump.rs` and `sniffer/src/dispatch.rs` are **real captured
  bytes**. Keep them byte-exact.

## State of play

Working: capture, reassembly, adaptive deframing, `Any` unwrapping,
schema-vs-wire mismatch detection, signed-varint decoding, every message
archived to `packets`. 94 distinct message keys observed in one session.

**Messages are referred to by semantic name, never by wire key.** `sniffer/src/messages.rs`
owns the `name <-> key` mapping and is the only place a rotated key changes;
`sniffer/keymap.json` overrides it at runtime with no rebuild. Adding a message:
name it in `messages::DEFAULTS`, parse it in `interpret.rs` matching on the
*name*, optionally persist it in `build_dispatch()` via
`messages::keymap().key("...")`, and pin it with a test over real bytes.
`price_list` is the worked example.

| semantic name | key (this build) | meaning |
|---|---|---|
| `price_list` | `kea` | marketplace ladder x1/x10/x100/x1000 -> `prices` table |
| `chat_message` | `ksv` | chat/trade channel |
| `crush_result` | `kfy` | brisage: yield + focus -> `crushes`. Runes parsed but NOT stored — derivable from item stats + coefficient |
| `item_detail` | `kev` | uid -> item type id; cached to fill `crushes.item_id` |
| `crush_request` | `ker` | the crush command; field 1 = focus effect id, absent if none |
| `price_list_legacy` | `kdh` | the 2026-07-10 price list; gone from the wire, kept for tests |

Next up (RUNBOOK part 3 items 5-6): identify `iuz` — 3 seen, 68-80 KB each,
server-only, matched a full price ladder during known-plaintext search, so it
is probably the whole marketplace in one payload and worth more than
`price_list`. Then `idd` (88 seen, server-only, 15-166 B). Highest-volume
unidentified keys over 7057 messages are `iwa` 1586, `jri` 1569, `jrj` 1250,
`kmw` 1163.

Partly done: runtime schema extraction works and is proven end-to-end —
`agent.ts` pulls each `.proto` file's serialized `FileDescriptorProto`,
`sniffer/tools/parse_descriptors.py` turns it into `sniffer/proto/messages.runtime.json` keyed
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
`Dispatcher::on_any` (`ARCHIVE_PACKETS=0` disables), and `sniffer/tools/replay.py`
exercises the whole pipeline over loopback so the client is not needed to test.

Not done: nothing consumes `messages.runtime.json`; the `decoded` column stays
NULL. `dump.cs` is gitignored (64 MB) — extract it from the Il2CppDumper zip to
use `gen_proto.py`. Details in `RUNBOOK.md` part 3.
