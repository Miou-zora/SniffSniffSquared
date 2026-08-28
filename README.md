<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo/banner-dark.png">
  <img src="docs/logo/banner-light.png" alt="SniffSniffSquared — passive protobuf sniffer for Dofus 3" width="820">
</picture>

**A passive network sniffer and protobuf decoder for the Dofus 3 game protocol —
and the trading dashboard built on what it captures.**

[![Rust](https://img.shields.io/badge/Rust-stable-CE422B?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

The game speaks an undocumented, obfuscated protobuf protocol over TCP. This
reads it off the wire without touching the client: reassembles the stream,
works out the framing by itself, unwraps the `google.protobuf.Any` envelopes,
decodes the bodies against a recovered schema, and writes what it understands
to Postgres.

The second half is the reason to collect any of it. `web/` turns those captures
into decisions: what an item is worth broken down into runes, what a craft costs
off the marketplace batch ladder, and which of a job's recipes actually pay.

[![The breaker view — an item in the crusher, with what it is worth](docs/screenshots/breaker.png)](docs/screenshots/breaker.png)

<div align="center"><sub><b>/</b> — the item currently in the crusher, and what breaking it pays at the coefficient a previous crush measured.</sub></div>

---

## Contents

- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Engineering notes](#engineering-notes)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Status and limitations](#status-and-limitations)
- [Platform support](#platform-support)
- [License](#license)

## What it does

**`sniffer/` — capture and decode** (Rust, ~4.5k lines, 74 tests)

- Passive libpcap capture on TCP 5555. It never connects, injects or modifies
  anything; the client cannot tell it is there.
- TCP stream reassembly, then an **adaptive deframer** that discovers the frame
  layout at runtime instead of assuming one.
- `google.protobuf.Any` unwrapping, keyed on the type URL that identifies each
  message.
- Protobuf decoding with signed-varint handling and **schema-vs-wire mismatch
  detection** — when the recovered schema disagrees with the bytes, the bytes
  win and the disagreement is printed.
- Every message archived to `packets`, understood or not, so a message
  identified next month can be decoded from traffic captured today.

**`web/` — the dashboard** (Next.js 16, React 19, Tailwind 4)

- **Breaker view** — what the item in the crusher yields in runes and kamas,
  per focus, at the coefficient a real crush measured.
- **Item catalogue** — every breakable item ranked by profit against the cheaper
  of buying and crafting, and the same table read the other way: what has never
  been measured.
- **Craft basket** — several crafts pooled into one shopping list, priced off
  the batch ladder, with what the bags already hold taken off the top.
- **Craft opportunities** — which of a job's consumable recipes sell for more
  than their ingredients cost, and where **recycling** a unit into nuggets pays
  better than selling it.
- **Price history** — `prices` is a time series, and this reads all of it.
- Live updates over Postgres `LISTEN`/`NOTIFY` relayed as SSE — the page
  refreshes when the sniffer inserts, with no polling.

## Screenshots

<table>
<tr>
<td width="50%"><a href="docs/screenshots/items.png"><img src="docs/screenshots/items.png" alt="The item catalogue ranked by profit"></a></td>
<td width="50%"><a href="docs/screenshots/coverage.png"><img src="docs/screenshots/coverage.png" alt="The same table showing what has never been broken"></a></td>
</tr>
<tr>
<td><b>/items</b> — every breakable item, valued for an average copy against the cheaper of buying and crafting.</td>
<td><b>/items</b>, other question — a coefficient comes only from a crush, so the 92 items nobody has broken show dashes rather than a guess dressed up as arithmetic.</td>
</tr>
<tr>
<td><a href="docs/screenshots/opportunities.png"><img src="docs/screenshots/opportunities.png" alt="Craft opportunities per job"></a></td>
<td><a href="docs/screenshots/recycle.png"><img src="docs/screenshots/recycle.png" alt="The rows where recycling pays better than selling"></a></td>
</tr>
<tr>
<td><b>/opportunities</b> — consumable recipes whose ingredients cost less off the ladder than the result sells for. Equipment is excluded; the breaker pages answer that.</td>
<td><b>/opportunities</b>, recycling — the same unit valued as nuggets instead. Whichever of the two pays more is the one in white, and 94 of the 373 known items are worth recycling rather than selling.</td>
</tr>
<tr>
<td><a href="docs/screenshots/craft.png"><img src="docs/screenshots/craft.png" alt="The craft basket and its shopping list"></a></td>
<td><a href="docs/screenshots/price-history.png"><img src="docs/screenshots/price-history.png" alt="One rune's price history"></a></td>
</tr>
<tr>
<td><b>/craft</b> — quantities are summed across the whole basket <i>before</i> they are priced, because the ladder prices 4 Ébonite differently from 2 twice over.</td>
<td><b>/item/[id]</b> — every rune figure in the app multiplies by a rune's x1 price, so whether that number has been drifting is worth seeing rather than assuming. The y-axis covers the range, not zero.</td>
</tr>
</table>

> These run on `tools/seed_sample.py`, which builds a demo database so the app
> can be explored with no game client and no capture session. Item names,
> levels, templates and recipes in it are real, from DofusDB; every price,
> listing, bag and crush yield is fabricated. See
> [Option A](#option-a--the-dashboard-only-no-game-required).

## How it works

```mermaid
flowchart LR
    C["Dofus 3 client"] -->|"TCP :5555"| W(("wire"))
    W --> L["libpcap"]
    subgraph S ["sniffer/ · Rust"]
        L --> RA["TCP reassembly"]
        RA --> DF["adaptive deframer"]
        DF --> AN["Any unwrap"]
        AN --> DE["protobuf decode"]
    end
    DE --> DB[("PostgreSQL")]
    subgraph WEB ["web/ · Next.js"]
        SC["Server Components"] --> UI["dashboard"]
    end
    DB --> SC
    DB -. "LISTEN/NOTIFY → SSE" .-> UI
    API["DofusDB API"] -. "names, icons, recipes" .-> SC
```

The wire format, once deframed:

```
TCP :5555
  └─ varint-length-prefixed frame
      └─ Frame { oneof { Request, Response, Payload event } }
          └─ Any  type.ankama.com/<key>   ← the message identity
              └─ message body
```

The traffic is **not encrypted**. It is plaintext protobuf with obfuscated type
names, so most of the work is not decryption — it is working out which schema
belongs to which three-letter message key.

`sniffer/` writes to Postgres and `web/` reads from it. That is the only
coupling between them, which is what keeps each independently runnable.

## Quick start

### Option A — the dashboard only (no game required)

The fastest way to see what this is. Needs Docker and Python 3 with `requests`.

```sh
git clone https://github.com/Miou-zora/SniffSniffSquared.git
cd SniffSniffSquared
cp .env.example .env            # defaults work as-is for local use

docker compose up -d            # postgres + pgadmin + the web app
                                # first run builds the web image — a few minutes

tools/import_runes.py           # rune constants, resolved against DofusDB
tools/seed_sample.py            # a demo database to browse
```

Then open <http://localhost:3000>.

On Windows, or wherever the scripts are not executable, call them through the
interpreter instead: `python tools/import_runes.py`.

`seed_sample.py` keeps two kinds of data strictly apart, and the split is the
point:

- **Reference data is real**, from DofusDB — item names, levels, types, icons,
  template stat ranges, recipes and the job that crafts them. The same rows
  `tools/import_items.py` writes, from the same endpoint.
- **Observations are fabricated** — marketplace ladders, individual listings,
  what one copy rolled, crush yields, bag contents. Only the server knows those,
  so the wire is their only honest source and none of this came off it.

The figures are invented but not arbitrary: rune prices scale with
`rune_weight`, gear is priced backwards from what breaking it is worth, and
resource prices are then solved from the gear they make — price a resource from
its own level instead and crafting comes out sixty times cheaper than breaking,
which makes every profit column read in the thousands of percent. Seeded per
item id, so a re-run reproduces the same database.

**A demo database is not a capture.** Do not point `tools/check_brisage.py` at
one, and do not read a yield in it as evidence about the model. `packets` is
never touched, so a real archive survives a seed. Re-running wants `--reset`:
`prices` has no unique key, so seeding twice doubles the series.

### Option B — the full thing, with capture

Additionally needs:

- **Rust stable** — `rustup default stable`.
- **Dofus 3 running and logged in.** The sniffer only sees traffic that exists;
  with the game closed it will sit there capturing nothing.
- **A packet capture driver.** libpcap on macOS and Linux, already present on
  both. **On Windows install [Npcap](https://npcap.com/#download)** — the
  capture path is the same libpcap API, but Windows ships no driver for it.
  Tick **"Install Npcap in WinPcap API-compatible Mode"**: that is what puts
  `wpcap.dll` in `System32`, where the default DLL search order finds it.
  Without it the DLL lands only in `System32\Npcap\`, which is not searched.
- **Permission to capture.** On macOS that means being in `access_bpf`;
  otherwise prefix the capture command with `sudo`:

  ```sh
  id -Gn | tr ' ' '\n' | grep access_bpf   # prints access_bpf if you are
  ```

  On Linux, either `sudo` or grant the binary the capability once:
  `sudo setcap cap_net_raw,cap_net_admin=eip ./target/debug/SniffSniffSquared`.

  On Windows, Npcap's driver loads at boot and its service does the privileged
  work, so an ordinary terminal captures fine. If you chose *"Restrict Npcap
  driver's access to Administrators only"* during setup, run the terminal as
  Administrator instead.

Optional: `pipx install frida-tools`, only for the runtime schema recovery in
RUNBOOK part 3.

The Rust app **must be run from `sniffer/`** — it resolves `keymap.json`,
`schema.json` and `proto/messages.json` relative to the working directory.

```sh
cd sniffer
cargo build
./target/debug/SniffSniffSquared --list                    # find your interface
./target/debug/SniffSniffSquared --dev en0 --all "tcp port 5555"
```

`--list` prints `name`, description and bound addresses, one device per line.

On **Windows** the same thing, from `sniffer\` in PowerShell:

```powershell
cargo build
.\target\debug\SniffSniffSquared.exe --list
.\target\debug\SniffSniffSquared.exe --dev 192.168.1.10 --all "tcp port 5555"
```

Windows device names are `\Device\NPF_{31AC96FC-C2C5-...}` — a GUID nobody
should have to type. So `--dev` also accepts a **bound IP address**, or any
case-insensitive fragment of the **adapter description**; `--list` prints both.
An exact interface name still wins outright, so `--dev en0` on macOS and
`--dev eth0` on Linux are unchanged.

**Pick the adapter by its address, not by its name.** Run `ipconfig`, take the
IPv4 address of the interface you are actually online through, and pass that —
`--dev 192.168.1.10`. A machine with both an ethernet port and Wi-Fi will list
both, and a plausible-sounding description is no evidence the card is on the
network: an unplugged NIC shows a `169.254.x.x` address, captures perfectly
happily and returns nothing at all. The sniffer warns when you select one:

```
[!] \Device\NPF_{31AC...} has no routable address — it is probably not
    connected, and will capture nothing.
```

If a fragment matches more than one adapter the sniffer says so and lists the
candidates rather than guessing — Windows offers several near-identical virtual
adapters, and capturing on the wrong one is indistinguishable from a game that
sends nothing. Narrow the fragment, or paste the exact name.

`.env` supplies `DATABASE_URL`, so prices and the message archive are written
automatically. To be explicit, or if you skipped `.env`:

```sh
DATABASE_URL='postgres://dofus:change_me@localhost:5432/dofus' \
  ./target/debug/SniffSniffSquared --dev en0 --all "tcp port 5555"
```

<details>
<summary><b>Checking it is actually working</b></summary>

Within a few seconds you should see all of these:

```
[*] message keymap: 10 entries (0 from keymap.json) — chat_message=kti … price_list=kbt
[*] message schema: 15 definitions from schema.json
[*] schema registry: 2317 messages
[*] capturing on \Device\NPF_{A3307B35-…} (filter: tcp port 5555) [all frames]
[db] connected; price_list (kbt) -> table prices
[db] archiving all messages -> table packets
[a.b.c.d:5555 -> w.x.y.z:NNNNN] framing locked: Varint includes_self=false lead_skip=0
```

**`framing locked` is the line that matters** — it means real game traffic is
being deframed. If it never appears, see [Troubleshooting](#troubleshooting).

Then browse the marketplace in game, and prices accumulate:

```sh
docker exec dofus_db psql -U dofus -d dofus -c \
  'SELECT seen_at, item_id, b1, b10, b100, b1000 FROM prices ORDER BY seen_at DESC LIMIT 10;'
```

Decoded output looks like this, with the decoder flagging where the recovered
schema disagrees with the bytes:

```
Any <type.ankama.com/ksv> [ksx.ksw.ksv] <!! schema mismatch on 3 fields>
  2: varint 53207171425
  3: bool true
  7: string "2026-07-29T16:21:53+02:00"   <!schema: declared long>
  8: string "Player-Redacted-02"          <!schema: declared bool>
  9: string "<chat message text>"         <!schema: declared packed, reads as text>
```

</details>

<details>
<summary><b>Running the sniffer in Docker — Linux only</b></summary>

```sh
docker compose --profile capture up -d sniffer   # DOFUS_DEV must be eth0, ens18, …
docker compose logs -f sniffer
```

It sits behind a `capture` profile so it never starts by accident.

**This cannot work on macOS or Windows.** Docker runs containers inside a Linux
VM, so `network_mode: host` attaches to the VM's network, not your machine's —
the container sees `eth0` and `docker0`, never `en0`, and captures nothing while
looking perfectly healthy. Run the binary natively there. Everything else about
the image is fine on those platforms: it builds, the schema and keymap load, and
it reaches Postgres — only the packets are missing.

</details>

### Stopping

```sh
# Ctrl-C the sniffer, then from the repo root:
docker compose down             # add -v to also delete the captured data
```

## Engineering notes

The parts that were actually hard, and what the code does about them.

### The frame layout is discovered, not assumed

`FrameDelimiter` prefixes each frame with a length header, but the static dump
does not pin down how wide it is, whether it counts itself, or whether a
transport discriminator byte sits before the `Frame` protobuf. Guessing wrong
desynchronises the stream permanently rather than failing loudly.

So the layout is measured instead of assumed. The deframer scores **seven
candidate layouts** — a varint, `u16` or `u32` length prefix, `includes_self`,
and a lead-skip of 0 or 1 — by how many consecutive frames each can parse, up to
twelve, and locks the best candidate that manages **at least three**. A frame
only counts if its body is a substantial, fully-consumable protobuf message, so
a stray `0A 00` cannot score. That is the `framing locked` line above, and it
resolves in the first few packets of a connection.

### The obfuscated message keys rotate between client builds

Ankama compiles message names down to three-letter tokens, and **those tokens
change between builds**. Measured across the 2026-08-04 update: of 141 keys seen
before it and 91 after, **19 are shared**, and the connection handshake —
byte-identical every session — has not one token in common. All ten identified
messages moved. A message that decoded fine last month goes silent after a
patch: it is still on the wire, under a new name.

Worse, a key that *survives* a rotation may now mean something else. `iun` was
`inventory_add`; it is still on the wire and now carries pods. A stale mapping
that still resolves writes nonsense, which is worse than one that fails.

So no code anywhere names a wire token. It says `price_list`, and
`sniffer/src/messages.rs` holds what `price_list` is called on this build:

```rust
pub const DEFAULTS: &[(&str, &str)] = &[
    ("price_list", "kbt"),
    ("chat_message", "kti"),
    // …
];
```

[`sniffer/keymap.json`](sniffer/keymap.json) overrides that at runtime — change
a token, restart, no rebuild and no code. It ships empty on purpose: the
defaults match the wire and are covered by tests over real captured bytes, so
duplicating them would only invite the two to drift. Invalid JSON prints a
warning and keeps running on the defaults rather than killing a capture in
progress.

### The field numbers rotate too, so message shapes are data as well

Keys are not the only thing an update moves. The 2026-08-04 build shifted a
field number in every message `interpret.rs` reads except one. Structure
therefore lives in [`sniffer/schema.json`](sniffer/schema.json) rather than in
Rust: `src/schema.rs` walks it into a `Node`, and small adapters turn a `Node`
into the typed struct.

**Meaning stays in Rust.** "An empty ladder is not a price message", "quantity
absent means one", "a negative delta is a removal" — those are decisions, not
structure, and they do not rotate.

The file is read from the working directory, so a rotation needs no rebuild; the
same file is compiled in as a fallback for a sniffer started from the wrong
directory. `sniffer/testdata/schema-2026-07-10.json` describes the *previous*
build so its captured fixtures still run — same parsers, two schemas, real bytes
from each. That two-build suite is the guard, because a schema that is subtly
wrong parses to something plausible rather than failing.

### When the schema and the wire disagree, the wire wins — loudly

The committed schema registry (2317 messages, extracted from a 2026-07-10
IL2CPP dump) describes a build whose keys the current wire no longer uses, so a
name that still resolves may now describe a **completely different message**. It
was measured wrong for 4 of the 6 keys observed at the time.

A wrong schema is worse than no schema: it forces strings through the packed-int
path and prints digit soup that looks like a decoding bug. So the decoder
compares the declared type against what the bytes actually are, decodes as the
bytes, and tags the disagreement — the `<!schema: declared long>` markers above.

### Messages are identified empirically, with no schema at all

Two tools, neither of which needs a schema or touches the client:

```sh
# You can read exact numbers off the screen (prices, a quantity, an id).
# Known-plaintext search: finds those values as protobuf varints in the archive.
sniffer/tools/findvalue.py 75 326 6660 99999

# You cannot read exact values, but you can trigger the message on demand.
# Samples a quiet baseline, then reports what appears while you act.
sniffer/tools/identify.py "open HDV and click several item prices"
```

`findvalue.py` is the stronger of the two when it applies: pass three or more
numbers from one screen and the message carrying all of them is the one you
want. That is exactly how `price_list` was found — four prices read off an item,
all four together in one 25-byte message.

Some identifications need neither. The inventory message was pinned without
reading anything off the screen: every item ever put into the breaker (12 of 12,
matched by instance uid) appears in the `iss` that preceded its placement, and
none appear in `iso`, the other container listing.

### Archiving everything makes identification retroactive

`packets` stores every message, decoded or not. A key identified next month can
therefore be decoded from traffic captured today — which is what the
`tools/backfill_*.py` scripts do, recovering marketplace offers, crushes and bag
contents from an archive that was collected before anything knew what they were.

### The capture path takes no network dependency

Item names, icons and recipes come from the DofusDB API, and the sniffer never
calls it. Enrichment is either read-side in `web/` or an offline step in
`tools/`, so a DofusDB outage degrades the UI and can never cost a packet.

### Two different things that look like one

- **`item_stats`** — what one *instance* actually rolled, off the wire, keyed by
  instance uid. The crush destroys the instance, so this is the only record it
  ever existed.
- **`item_effects`** — what the item *type* can roll, from DofusDB, as min/max
  per line. Averaging it estimates a copy you do not own, which is what "is this
  worth buying to break" needs before you have one.

Conflating them means judging an item you are about to buy by the roll of one
you happen to hold.

## Project layout

Two apps over one database. Shared infrastructure stays at the root; each app
owns its own folder.

```
docker-compose.yml   postgres + pgadmin + web; `sniffer` is Linux-only
init.sql             the schema both apps depend on — 15 tables, 2 views
.env.example         connection settings
docs/                captured-traffic analysis, the kamas maths, screenshots
tools/               offline enrichment, backfills, db backup/restore,
                     extract_nuggets.py, and seed_sample.py
RUNBOOK.md           the protocol guide

sniffer/             the Rust capture app — RUN IT FROM THIS DIRECTORY
  keymap.json          message name -> wire token. EDIT THIS after a game update
  schema.json          the shapes inside them; rotates on the same schedule
  src/                 capture, reassembly, deframing, decoding
    messages.rs          name <-> token mapping and its built-in defaults
    schema.rs            walks schema.json into a Node the parsers read
    interpret.rs         per-message decoding, keyed on semantic name
    dump.rs              the decoder, and the schema-mismatch detection
  proto/               messages.json (schema registry) + generated dofus3.proto
  tools/               findvalue.py / identify.py (identify a message),
                       gen_proto.py, replay.py, resign-debug-app.sh
  tools/frida/         runtime schema extraction from the live client
  reference/           IL2CPP dump + deobfuscation mappings

web/                 Next.js front end — breaker, catalogue, basket, opportunities
  AGENTS.md            what the app is, the data it reads, decisions taken
  design/              the "Modal" design system — tokens, reference, theme.css
  src/lib/             the model and the queries, server-side
  src/app/             App Router pages
```

## Configuration

One `.env` at the repo root, read by both `docker compose` and the sniffer.

| variable | default | what it does |
|---|---|---|
| `POSTGRES_USER` / `_PASSWORD` / `_DB` | `dofus` / `change_me` / `dofus` | database credentials |
| `POSTGRES_PORT` | `5432` | host port for Postgres |
| `DATABASE_URL` | `postgres://dofus:change_me@localhost:5432/dofus` | where the sniffer writes |
| `DOFUS_DEV` | `en0` | capture interface. `--list` prints the options |
| `BPF_FILTER` | `"tcp port 5555"` | capture filter. **Keep the quotes** — unquoted, `dotenvy` stops parsing at the space and silently drops every variable declared after it, `DATABASE_URL` included |
| `ARCHIVE_PACKETS` | `1` | `0` stops archiving every message to `packets` |
| `WEB_PORT` / `WEB_DEV_PORT` | `3000` / `3001` | front end, production and hot-reload |
| `PGADMIN_EMAIL` / `_PASS` / `_PORT` | `admin@example.com` / `change_me` / `5050` | pgAdmin at <http://localhost:5050> |

Inside compose the database host is `db`, not `localhost` — `localhost` in a
container is the container. `docker-compose.yml` sets `DATABASE_URL` accordingly,
so that path needs no configuration.

## Development

### The sniffer

```sh
cd sniffer
cargo build && cargo test        # 74 tests, over real captured bytes
cargo run -- --list
```

Test fixtures are **real captured bytes** — keep them byte-exact. The suite runs
the same parsers against two builds' schemas, so a rotation that breaks the old
fixtures is caught rather than absorbed. `sniffer/tools/replay.py` pushes a
recorded session over loopback, so the whole pipeline can be exercised with no
game client running.

Adding support for a new message takes four steps, documented in
[RUNBOOK.md](RUNBOOK.md) part 2 step 6 with `price_list` as the worked example:
name it in `messages::DEFAULTS`, parse it in `interpret.rs` matching on the
*name*, optionally persist it in `build_dispatch()`, and pin it with a test over
real bytes.

### The front end

```sh
cd web
cp .env.example .env.local       # DATABASE_URL, same Postgres
pnpm install
pnpm dev                         # http://localhost:3000
pnpm check                       # typecheck + lint + format — the gate before committing
```

`pnpm dev` on the host is the fastest loop. In containers instead:

```sh
docker compose up -d db web              # production build, port 3000
docker compose up -d --build web         # refresh it after changes

docker compose --profile dev up -d web-dev   # hot reload, port 3001
docker compose --profile dev watch           # then sync changes on save
```

Start the `web-dev` container before `watch` — `watch` alone does not reliably
start a profile-gated service. The production `web` service is deliberately not
watched.

## Troubleshooting

| symptom | cause |
|---|---|
| no `framing locked` line | the game is not running, or the wrong `--dev` interface — check `--list` |
| runs, prints `capturing on …`, then nothing at all | almost always the wrong adapter. Confirm the game really is connected and find the address to use: `Get-NetTCPConnection -OwningProcess (Get-Process Dofus).Id \| Where-Object State -eq 'Established'` — the `RemotePort 5555` row's `LocalAddress` is what to pass to `--dev`. A `[!] no routable address` warning means the one you picked is not on a network |
| `Permission denied` opening the device | macOS/Linux: not in `access_bpf`; use `sudo`. Windows: Npcap installed Administrators-only — use an elevated terminal |
| Windows: build fails on `wpcap`, or the binary starts and immediately dies | Npcap missing, or installed without WinPcap API-compatible mode so `wpcap.dll` is not on the DLL search path. `Test-Path C:\Windows\System32\wpcap.dll` should be `True` — see [Option B](#option-b--the-full-thing-with-capture) |
| Windows: `--list` prints nothing | the Npcap driver is not running: `Get-Service npcap` should say `Running`. Not `sc query npcap` — in PowerShell `sc` is an alias for `Set-Content` |
| `device X is ambiguous` | the `--dev` fragment matched several adapters; it lists them — narrow it or paste the exact name |
| no `[db] connected` line, **and no error either** | `DATABASE_URL` never reached the process. An `.env` with `BPF_FILTER` unquoted makes `dotenvy` stop parsing at the space and silently drop every variable declared after it |
| runs, but `prices` stays empty | you have not opened the marketplace, or a game update rotated the key — see [the keymap](#the-obfuscated-message-keys-rotate-between-client-builds) |
| `no proto/messages.json` | you are not running from `sniffer/` |
| the compose `sniffer` service captures nothing | you are on macOS or Windows — it is Linux-only, run the binary natively |
| `pnpm dev` cannot bind port 3000 | the `web` container has it: `docker compose stop web` |
| every page is empty | nothing has been captured yet — see [Option A](#option-a--the-dashboard-only-no-game-required) |

## Documentation

| file | what it covers |
|---|---|
| **[RUNBOOK.md](RUNBOOK.md)** | **Start here for protocol work.** How the protocol works, a copy-pasteable command sequence, every trap, and what remains to be done. |
| **[blog/](blog/)** | The same material as a narrative: six posts on how the protocol was read, the schema route that deadlocked, and what was deliberately ruled out. Explanatory rather than reference. |
| [CLAUDE.md](CLAUDE.md) | Condensed orientation: ground truth, layout, conventions, traps. |
| [web/AGENTS.md](web/AGENTS.md) | The front end: the data it reads, the decisions taken and why. |
| [docs/observations.md](docs/observations.md) | Annotated real captures with byte-level analysis. |
| [docs/brisage-model.md](docs/brisage-model.md) | The kamas maths: how crushing an item into runes pays, transcribed from `Book 3.xlsx` and measured against real captured crushes. |
| [sniffer/tools/frida/README.md](sniffer/tools/frida/README.md) | Runtime schema extraction routes. Partly stale — RUNBOOK.md supersedes it. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | What belongs here and what does not, the setup, and the four steps to add a message. A key rotation is the most useful thing an outsider can contribute. |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability privately, what counts as one when every byte on the wire is untrusted input, and how to run the stack safely. |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Contributor Covenant 2.1, plus two rules this project needs: do not publish other players' data, do not point it at anyone else. |

## Status and limitations

**Working** — capture, TCP reassembly, adaptive deframing, `Any` unwrapping,
signed-varint decoding, schema-vs-wire mismatch detection, and every message
archived to `packets`. Ten message types are named and parsed against
`schema.json`; the marketplace, crush, item-detail and inventory families are
persisted into tables of their own, and the decoder survived the 2026-08-04
rotation by editing two JSON files.

**Known limits**

- The obfuscated keys rotate between client builds, so the committed schema
  registry does not describe the current wire. Message types are identified
  empirically instead — see [above](#messages-are-identified-empirically-with-no-schema-at-all).
- Field *names* are unknown for the game protocol. The registry carries field
  numbers and C# types only, so `packets.vars` and `packets.packs` are
  unreliable; `packets.body` is the ground truth.
- Runtime schema recovery via Frida is implemented and proven on the chat
  service (51 messages with real field names), but the scan deadlocks before
  reaching `Ankama.Dofus.Protocol.Game`, and attaching to a client anyone is
  using will eventually crash it. Nine approaches are ruled out in RUNBOOK
  part 3.
- Most keys are still unidentified — 91 were seen on the wire after the
  2026-08-04 build and ten of them are named — including the highest-volume ones
  and a ~70 KB server payload that is probably the whole marketplace in one
  message.
- Recycling yield is static client data and the search for it on the wire is
  over: `tools/extract_nuggets.py` reads it out of the game's own asset bundles
  instead. The model lands within display rounding on consumables and resources
  and fails on equipment, so `web/` shows no recycle figure for gear rather than
  fitting a third parameter to five measurements.

RUNBOOK.md part 3 has the ordered list of what is next.

## Platform support

Capture is portable — it is libpcap, and works anywhere the binary runs
natively. Developed on macOS (Darwin 25.5, Apple Silicon) and verified on
Windows 11 with Npcap, where `--dev` also accepts a bound IP address or an
adapter-description fragment because the real device names are GUIDs. The
database, tools and front end run on all three.

Two things are platform-bound:

- the **Frida tooling** in `sniffer/tools/frida/` is macOS-specific;
- the **compose `sniffer` service captures on Linux only**, for the Docker VM
  reason described above.

## License

[MIT](LICENSE).

Passive observation of your own client's traffic, for interoperability research.
It sends nothing, modifies nothing, and automates no part of the game. Not
affiliated with Ankama.
