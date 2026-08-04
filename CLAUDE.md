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
- **The obfuscated `Any` keys ROTATE between client builds, and so do the field
  numbers inside them.** Measured across the 2026-08-04 update: of 141 keys seen
  before it and 91 after, 19 are shared, and the connection handshake — identical
  every session — has not one token in common. All ten identified messages moved.
  Any "key X means Y" mapping is only valid for the build it was observed on.
  Re-identify with `sniffer/tools/identify.py` rather than trusting notes.
- **A key that survives a rotation may now mean something else entirely.** `iun`
  was `inventory_add`; it is still on the wire and now carries pods,
  `{1: current weight, 3: max}`. A stale mapping that still resolves writes
  nonsense, which is worse than one that fails.
- **Static game data never crosses the wire.** Recipes and template stat
  ranges — anything a tooltip draws — live in the client's data files. The
  server is only asked what it alone knows, which is prices. Three negative
  probes are written up in `RUNBOOK.md` part 1; do not re-run them. DofusDB is
  the source for both, in bulk via `tools/import_items.py` and at read time in
  `web/` for ids the importer has not reached.
- **Recycling yield is one of those, and the search for it on the wire is
  finished.** `kcr` is a seven-byte placement — field 1 a signed delta, field 2
  an instance uid, all bytes consumed — and carries no third value; it is also
  client->server, so it could not report a figure the client just computed. A
  121-message recycler session decoded field by field holds no float or scaled
  integer matching an observed payout, and across the whole archive `4.5`,
  `2.70` and `0.46` never appear as f32 or f64. The number lives in the client's
  asset bundle. Do not go looking for it in packets again.
- **But `recyclingNuggets` is not the yield, for a craftable item.** The field
  is 0 for all 4511 of them, on DofusDB *and* in the bundle it faithfully
  mirrors — the client decomposes those into resources and sums instead, which
  is why `RecycleUi.GetItemNuggets` takes a `Dictionary<int, int> resources`
  rather than an item. Storing the raw field writes 0 for exactly the items a
  craft dashboard cares about, and 0 reads as "not worth recycling" rather than
  as "not computed". `tools/extract_nuggets.py` does the decomposition off the
  bundles and fills `items.recycle_nuggets`; DofusDB is only ever allowed to
  write a *non-zero* value into it. Then `web/src/lib/recycle.ts` applies the
  bonuses and the character share. Measured, all at a 60% share: Rune Invo
  4.5 -> 2.70 no bonus, Multygely 0.5060 -> 0,46 at craft, Essence du Craqueleur
  Légendaire 0.2097 -> 0,57 at craft x boss.
- **The model holds for consumables and resources and fails on equipment**, so
  `web/` shows no figure for gear. A Gelano reads 13.6% over the prediction and a
  Marteau Ridhe 2.5% over — same direction, different factor, so it is not one
  missing multiplier. Stat quality was checked and is not it: the Marteau rolled
  8.9% above its template weighted, four times the gap to close, and the Gelano's
  only templated line is fixed at 1 and cannot roll high at all. Whatever the
  factor is, it is not in the item data. Deliberately dropped rather than
  guessed — do not fit a third parameter to five points.
- **Messages are keyed by the `Any` type URL** (`type.ankama.com/kbt`), not by
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
run from `sniffer/`** (it resolves `keymap.json`, `schema.json` and `proto/`
relative to cwd).

```
docker-compose.yml  postgres + pgadmin + web; `sniffer` service is Linux-only
init.sql            schema both apps depend on (packets, prices, offers,
                    offer_stats, crushes, crush_placements, item_stats, items,
                    item_effects, recipes, runes, inventory,
                    + item_marks/app_settings/craft_basket which `web/` owns
                    and writes)
                    + views item_effect_weights, item_break_weight
docs/               observations.md — annotated real captures
                    brisage-model.md + brisage-runes.json — the kamas maths,
                    transcribed from Book 3.xlsx (kept at the repo root)
backups/            pg_dump output from the `db-backup` service; gitignored
tools/              backup_db.sh      one compressed dump + pruning; the
                                      `db-backup` service runs it on a loop
                    restore_db.sh     put one back, --list to see them
                    import_runes.py   seeds `runes` from brisage-runes.json
                    import_items.py   backfills `item_stats` from `packets`,
                                      names ids into `items` via DofusDB, and
                                      fills `recipes` (+ names their ingredients,
                                      which the wire has usually never seen)
                    extract_nuggets.py fills `items.recycle_nuggets` from the
                                      client's own bundles, decomposing every
                                      craftable into resources (needs UnityPy;
                                      reads the install, never writes to it)
                    check_brisage.py  runs the brisage model over every
                                      captured crush, predicted vs actual
                    backfill_offers.py parses marketplace listings out of
                                      archived packets into offers/offer_stats
                    backfill_crushes.py recovers crushes the interpreter once
                                      rejected for yielding no runes
                    backfill_inventory.py replays the newest archived bag
                                      listing into `inventory`
RUNBOOK.md          the guide. Start here for anything protocol-related.

sniffer/            the Rust capture app — RUN IT FROM THIS DIRECTORY
  src/                module table in RUNBOOK.md part 1
  proto/              messages.json (schema registry) + generated dofus3.proto
  keymap.json         wire-key overrides — edit when a build rotates keys
  schema.json         message shapes + field numbers; rotates on the same schedule
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
icons and types with no mapping table. **The sniffer never calls it** — the
capture path takes no network dependency, so a DofusDB outage can never cost
packets. Enrichment is either read-side in `web/` or an offline step
(`tools/import_items.py`, which fills the `items` table).

**Two different things, do not confuse them:**

- `item_stats` — what one *instance* actually rolled, off the wire, keyed by
  instance uid. The instance is destroyed by the crush, so this is the only
  record it ever existed. The wire wins here.
- `item_effects` — what the item *type* can roll, from DofusDB, as min/max per
  line. Averaging it estimates an unseen copy, which is what "is this item
  worth breaking" needs before you own one. `item_break_weight` does that sum.

Observed copies land 89–107% of their template average, which is the expected
spread. **Item 779 sits at 50%** and its captured stats fall outside the
template range entirely, so that id is not what the wire says it is — treat any
conclusion resting on it as unsound.

**The database is backed up automatically.** `db-backup` dumps the whole
database to `./backups` on the host every `BACKUP_INTERVAL` seconds (default
3600), keeps `BACKUP_KEEP` of them (default 24) and takes one immediately on
start. On by default and no profile, because the captured tables cannot be
refetched — `item_stats` describes instances the crush destroyed — and this
volume has already been deleted once with nothing to restore from. The host
directory survives `docker compose down -v` and a volume deleted in Docker
Desktop, which is the failure it is for.

```sh
docker compose exec db-backup /tools/backup_db.sh     # one now
docker compose exec db-backup /tools/restore_db.sh --list
docker compose exec db-backup /tools/restore_db.sh    # newest; asks first
```

`backup_db.sh` writes under a temporary name and only renames after
`pg_restore -l` parses the archive, so a dump killed half-written is never left
looking like a good one. Restore verified end to end into a scratch database:
16 966 packets, both views, all counts matching.

Compose services: `db`, `db-backup`, `pgadmin`, `web` start by default; `web-dev` needs
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
`keymap.json`, `schema.json` and `proto/messages.json` relative to the working
directory.

```sh
docker compose up -d                      # postgres + pgadmin, from repo root
cd sniffer
cargo build && cargo test                 # 74 tests
./target/debug/SniffSniffSquared --dev en0 --all "tcp port 5555"
./target/debug/SniffSniffSquared --dev en0 --raw "tcp port 5555"
./target/debug/SniffSniffSquared --list
docker exec dofus_db psql -U dofus -d dofus -c '\dt'
```

Capture runs natively on all three platforms.
**Windows needs [Npcap](https://npcap.com/#download)** installed — nothing else
differs, and no `cfg`-gated code exists. Because a Windows interface is named
`\Device\NPF_{GUID}`, `--dev` falls back to a bound IP address or a
case-insensitive fragment of the name/description when no exact name matches
(`--dev 192.168.1.10`); exact names still win, so `en0`/`eth0` are untouched. An
ambiguous fragment errors with the candidates listed rather than picking one.

**Select the adapter by address.** A box with both ethernet and Wi-Fi lists
both, and the idle one captures cleanly while returning nothing — the same
symptom as a closed game. `disconnected_warning` flags an interface holding only
a link-local address (`169.254/16`, `fe80::/10`); loopback is exempt because
`tools/replay.py` targets it deliberately.

## Traps that have already cost time

- **`cargo test` does not rebuild `target/debug/SniffSniffSquared`.** Run
  `cargo build` before capturing, or you will analyse output from a stale
  binary and reach wrong conclusions. This happened.
- **`.env` needs `BPF_FILTER` quoted.** `BPF_FILTER=tcp port 5555` unquoted
  makes `dotenvy` stop parsing at the space, so `DATABASE_URL` (declared
  later) silently never loads and the sniffer runs with no DB and no error.
  Symptom: no `[db] connected` line and no failure message either.
- **No sudo needed for capture** if the user is in `access_bpf` (they are).
- **The compose `sniffer` service cannot capture on macOS or Windows.** Docker's
  "host" network is the Linux VM, not your machine: the container sees
  `eth0`/`docker0`, never `en0`, and silently captures nothing. It is behind a
  `capture` profile so it does not start by default. On both, run the binary
  natively. The image itself is fine — it builds, loads keymap + registry, and
  reaches Postgres.
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

## Installed skills

`.agents/skills/`, symlinked into `.claude/skills/`, pinned by
`skills-lock.json`. Update with `npx skills update`.

| skill | source | why it is here |
|---|---|---|
| `frontend-design` | anthropics/skills | `web/` is a real UI now, with a design system to hold to |
| `systematic-debugging` | obra/superpowers | protocol work is debugging with no source; this repo's dead ends came from guessing instead of bisecting |
| `test-driven-development` | obra/superpowers | fixtures here are real captured bytes and were twice invented by hand instead |
| `verification-before-completion` | obra/superpowers | "it builds" has been claimed here when it did not |
| `ui-ux-pro-max` | nextlevelbuilder/ui-ux-pro-max-skill | searchable local design database; pairs with `frontend-design` |
| `writing-plans` / `brainstorming` | obra/superpowers | for multi-step work before touching code |

`ui-ux-pro-max` is 1.8 MB, nearly all CSV reference data, and is the only skill
here from outside anthropics/obra. Audited before committing: standard library
only, no network, no `subprocess`/`eval`; its two file writes generate design
docs. Re-check after `npx skills update`.

Deliberately not installed: the marketing, SEO and video generation skills
(`ad-creative`, `hyperframes*`, `paywalls`, `pricing`, `seo-audit`, `video`,
`social`, ...). Nothing in this repo ships to an audience.

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

**The message shapes are data too, in `sniffer/schema.json`.** Field numbers
rotate with the keys — the 2026-08-04 update moved one in every message
`interpret.rs` reads except `crush_slot_put` — so structure lives in JSON and
`sniffer/src/schema.rs` walks it into a `Node`. Small adapters in `interpret.rs`
turn a `Node` into the typed struct. **Meaning stays in Rust**: "an empty ladder
is not a price message", "quantity absent means one", "a negative delta is a
removal". Those are decisions, not structure.

The file is loaded from the working directory, so editing it needs no rebuild;
the same file is compiled in as a fallback for a sniffer started from the wrong
directory. `sniffer/testdata/schema-2026-07-10.json` describes the previous build
so its captured fixtures still run — same parsers, two schemas, real bytes from
each. That two-build suite is the guard: a schema that is subtly wrong parses to
something plausible rather than failing, which is the trap
`sniffer/proto/messages.json` falls into. `Schema::parse` also rejects a dangling
submessage reference, a reused field number and a reused field name at load,
before a byte is read.

| semantic name | key (this build) | meaning |
|---|---|---|
| `price_list` | `kbt` | marketplace ladder x1/x10/x100/x1000 -> `prices` table |
| `chat_message` | `kti` | chat/trade channel |
| `crush_result` | `kfp` | brisage yield -> `crushes` (item_id + yield only). Runes and focus parsed for display but NOT stored: runes derive from stats+coefficient, and focus does not change the coefficient |
| `item_detail` | `kfb` | uid -> item type id; cached to fill `crushes.item_id` |
| `crush_request` | `kbj` | the crush command; field 1 = focus effect id, absent if none. Display only |
| `crush_slot_put` | `kcr` | item put into the breaker -> `crush_placements`. Carries only the uid; the type comes from the `item_detail` that answers it |
| `inventory` | `ivx` | the whole bag as a snapshot -> `inventory` (replaces the table). Entries share `item_detail`'s shape |
| `inventory_add` | `iua` | a new stack arrived -> upserts a row. One entry, in `item_detail`'s envelope |
| `inventory_quantity` | `ivj` | a stack changed size -> updates that row. It is the **new size, not a delta** |
| `inventory_remove` | `ium` | one instance has left the bag -> deletes that row. A bare uid |
| `price_list_legacy` | `kdh` | the 2026-07-10 price list; gone from the wire, kept for tests |

Field numbers deliberately left out of that table — they are in
`sniffer/schema.json`, which is the only place they belong now.

**Every key above was re-identified on 2026-08-04** and the previous build's set
(`kea ksv kfy kev ker kch iss iun iul ivf`) shares nothing with it. Watch for
tokens that survive a rotation carrying a *different* message: `iun` is still on
the wire and now means pods, `{1: current weight, 3: max}`. Left mapped to
`inventory_add` it would have written nonsense rather than failing.

`inventory` was identified without reading anything off the screen: every item
ever put into the breaker (12 of 12, matched by instance uid) appeared in the
listing that preceded its placement, and none appeared in the other container
listing. Re-confirmed against one purchase on 2026-08-04: the bought Palmano's
uid 2447309 appears in exactly one `ivx` and in no other listing. `ium` followed
from the same set — the crushed uid arrives there seconds after each crush.
Every check is a single query; redo them the next time a build rotates. RUNBOOK
part 3 has the shapes and the purchase sequence.

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
