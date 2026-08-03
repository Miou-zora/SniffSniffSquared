# SniffSniffSquared

Passive network sniffer and protobuf decoder for the Dofus 3 game protocol
(Unity / IL2CPP, `Ankama.SpinConnection`).

It captures TCP off the wire, reassembles the stream, works out the framing by
itself, unwraps the `google.protobuf.Any` envelopes, decodes message bodies
against a recovered schema, and writes selected messages to Postgres.

The traffic is **not encrypted** — it is plaintext protobuf with obfuscated
type names. Most of the work is figuring out which schema belongs to which
three-letter message key.

```
TCP :5555
  └─ varint-length-prefixed frame
      └─ Frame { oneof { Request, Response, Payload event } }
          └─ Any  type.ankama.com/<key>   ← the message identity
              └─ message body
```

## Running it

### 1. What you need

- **Docker** — for Postgres.
- **Rust stable** — `rustup default stable`.
- **Dofus 3 running and logged in.** The sniffer only sees traffic that exists;
  with the game closed it will sit there capturing nothing.
- **A packet capture driver.** libpcap on macOS and Linux, already present on
  both. **On Windows install [Npcap](https://npcap.com/#download)** — the
  capture path is the same libpcap API, but Windows ships no driver for it.
  The default installer options are what you want; "WinPcap API-compatible
  mode" is not required.
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

### 2. Start the database

From the repo root:

```sh
cp .env.example .env          # defaults work as-is for local use
docker compose up -d          # postgres + pgadmin
```

### 3. Capture

The Rust app lives in `sniffer/` and **must be run from there** — it resolves
`keymap.json` and `proto/messages.json` relative to the working directory.

```sh
cd sniffer
cargo build
./target/debug/SniffSniffSquared --list        # find your interface (usually en0)
./target/debug/SniffSniffSquared --dev en0 --all "tcp port 5555"
```

`--list` prints `name`, description and bound addresses, one device per line.

On **Windows** the same thing, from `sniffer\` in PowerShell:

```powershell
cargo build
.\target\debug\SniffSniffSquared.exe --list
.\target\debug\SniffSniffSquared.exe --dev Realtek --all "tcp port 5555"
```

Windows device names are `\Device\NPF_{31AC96FC-C2C5-...}` — a GUID nobody
should have to type. So `--dev` also accepts any case-insensitive fragment of
the **adapter description**, which is the readable half of `--list`:
`--dev Realtek`, `--dev "Intel(R) Wi-Fi"`. An exact interface name still wins
outright, so `--dev en0` on macOS and `--dev eth0` on Linux are unchanged.

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

### 4. Check it is actually working

Within a few seconds you should see all four of these:

```
[*] message keymap: 2 entries (2 from keymap.json) — chat_message=ksv price_list=kea
[*] schema registry: 2317 messages
[db] connected; price_list (kea) -> table prices
[a.b.c.d:5555 -> w.x.y.z:NNNNN] framing locked: Varint includes_self=false lead_skip=0
```

The **`framing locked`** line is the one that matters — it means real game
traffic is being deframed. If it never appears, see troubleshooting below.

Then browse the marketplace in game, and prices accumulate:

```sh
docker exec dofus_db psql -U dofus -d dofus -c \
  'SELECT seen_at, item_id, b1, b10, b100, b1000 FROM prices ORDER BY seen_at DESC LIMIT 10;'
```

Every message is archived to `packets` whether or not it is understood, so a
message identified later can be decoded from traffic captured today.

### 5. Stop

```sh
# Ctrl-C the sniffer, then from the repo root:
docker compose down             # add -v to also delete the captured data
```

### Troubleshooting

| symptom | cause |
|---|---|
| no `framing locked` line | the game is not running, or the wrong `--dev` interface — check `--list` |
| `Permission denied` opening the device | macOS/Linux: not in `access_bpf`; use `sudo`. Windows: Npcap installed Administrators-only — use an elevated terminal |
| Windows: link error on `wpcap` / `Packet.lib` when building | Npcap is not installed. The crate links against its driver library — see [what you need](#1-what-you-need) |
| Windows: `--list` prints nothing | the Npcap service is not running: `sc query npcap` |
| `device X is ambiguous` | the `--dev` fragment matched several adapters; it lists them — narrow it or paste the exact name |
| no `[db] connected` line, and no error either | `DATABASE_URL` never reached the process. An `.env` copied before this was fixed may have `BPF_FILTER` unquoted, which makes `dotenvy` silently drop every variable after it |
| runs, but `prices` stays empty | you have not opened the marketplace, or a game update rotated the key — see [keymap.json](#keymapjson--what-to-edit-when-the-game-updates) |
| `no proto/messages.json` | you are not running from `sniffer/` |

### Running the sniffer in Docker — Linux only

```sh
docker compose --profile capture up -d sniffer   # DOFUS_DEV must be eth0, ens18, ...
docker compose logs -f sniffer
```

It is behind a `capture` profile so it never starts by accident.

**This cannot work on macOS or Windows.** Docker runs containers inside a Linux
VM, so `network_mode: host` attaches to the VM's network, not your machine's —
the container sees `eth0` and `docker0`, never `en0`, and captures nothing while
looking perfectly healthy. On those platforms run the binary natively, as in the
quick start above. Everything else about the image is fine there: it builds, the
schema and keymap load, and it connects to Postgres — only the packets are
missing.

Sample decoded output:

```
Any <type.ankama.com/ksv> [ksx.ksw.ksv] <!! schema mismatch on 3 fields>
  2: varint 53207171425
  3: bool true
  7: string "2026-07-29T16:21:53+02:00"   <!schema: declared long>
  8: string "Player-Redacted-02"          <!schema: declared bool>
  9: string "<chat message text>"         <!schema: declared packed, reads as text>
```

The `<!schema ...>` tags are the decoder telling you the recovered schema
disagrees with the bytes — see below.

## keymap.json — what to edit when the game updates

Ankama obfuscates message names to three-letter tokens, and **those tokens
change between client builds.** A message that decoded fine last month can go
silent after a patch: it is still on the wire, just under a new name.

So the code never refers to a message by its wire token. It says `price_list`,
and [`sniffer/keymap.json`](sniffer/keymap.json) says what `price_list` is
called on your build:

```json
{
  "price_list": "kea",
  "chat_message": "ksv"
}
```

**If a message stops being collected after a game update, this file is what you
fix.** Change the token, restart the sniffer — no rebuild, no code. The startup
line shows what is in effect, so you can see immediately whether it took:

```
[*] message keymap: 2 entries (2 from keymap.json) — chat_message=ksv price_list=kea
```

Entries here override the built-in defaults in `sniffer/src/messages.rs`; anything you
leave out falls back to those. Keys starting with `_` are ignored, so you can
leave yourself notes. Invalid JSON prints a warning and keeps running on the
defaults rather than killing your capture.

### Finding the new token

Two tools, neither of which needs a schema or touches the game client:

```sh
# You can read exact numbers off the screen (item prices, a quantity, an id).
# Searches every archived message for those values as protobuf varints.
sniffer/tools/findvalue.py 75 326 6660 99999

# You cannot read exact values, but you can trigger the message on demand.
# Samples a quiet baseline, then reports what appears while you act.
sniffer/tools/identify.py "open HDV and click several item prices"
```

`findvalue.py` is the stronger of the two when it applies — pass three or more
numbers from the same screen and the message carrying all of them is the one
you want. That is exactly how `price_list` was identified: four prices read off
an item, all four found together in one 25-byte message.

Adding a brand-new message takes four steps, documented in
[RUNBOOK.md](RUNBOOK.md) part 2 step 6, with `price_list` as the worked example.

## Documentation

| file | what it covers |
|---|---|
| **[RUNBOOK.md](RUNBOOK.md)** | **Start here.** How the protocol works, a copy-pasteable command sequence, every trap, and what remains to be done. |
| [CLAUDE.md](CLAUDE.md) | Condensed orientation: ground truth, layout, conventions, traps. |
| [docs/observations.md](docs/observations.md) | Annotated real captures with byte-level analysis. |
| [docs/brisage-model.md](docs/brisage-model.md) | The kamas maths: how crushing an item into runes pays, transcribed from `Book 3.xlsx`. |
| [sniffer/tools/frida/README.md](sniffer/tools/frida/README.md) | Runtime schema extraction routes. Partly stale — RUNBOOK.md supersedes it. |

## Layout

The repo holds one app today and is laid out for a second (a Next.js front end
over the same database). Shared infrastructure stays at the root; each app owns
its own folder.

```
docker-compose.yml   postgres + pgadmin, shared by every app
init.sql             database schema (packets, prices)
.env.example         connection settings
docs/                captured-traffic analysis
RUNBOOK.md           the protocol guide

sniffer/             the Rust capture app — run it from this directory
  keymap.json          message name -> wire token. EDIT THIS after a game update
  src/                 capture, reassembly, deframing, decoding
    messages.rs          name <-> token mapping and its built-in defaults
    interpret.rs         per-message decoding, keyed on semantic name
  proto/               messages.json (schema registry) + generated dofus3.proto
  tools/               findvalue.py / identify.py (identify a message),
                       gen_proto.py, replay.py, resign-debug-app.sh
  tools/frida/         runtime schema extraction from the live client
  reference/           IL2CPP dump + deobfuscation mappings

web/                 Next.js front end (scaffolded, no features yet)
  AGENTS.md            what the app is, the data it reads, open decisions
  design/              the "Modal" design system — tokens, reference, theme.css
  src/app/             App Router pages
```

`sniffer/` writes to Postgres; `web/` reads from it. That is the only coupling
between the apps, which keeps them independently runnable.

### Running the web app

For development, on the host — starts in under a second and hot-reloads:

```sh
cd web
cp .env.example .env.local     # DATABASE_URL, points at the same Postgres
pnpm install
pnpm dev                       # http://localhost:3000
pnpm check                     # typecheck + lint + format — run before committing
```

Or as a container. Two modes:

```sh
# production build, port 3000. Does NOT pick up source changes:
docker compose up -d db web
docker compose up -d --build web        # refresh it after changes

# hot reload, port 3001. Syncs changed files into the running container:
docker compose --profile dev up -d web-dev
docker compose --profile dev watch
```

`docker compose watch` copies changed files straight in and Next's HMR reacts —
no rebuild. Start the container first: `watch` on its own does not reliably
start a profile-gated service. Dependency changes (`package.json`,
`pnpm-lock.yaml`) trigger a rebuild instead, since a file copy cannot install
anything.

The production `web` service is deliberately not watched — rebuilding a
production image on every keystroke is slow, and it fired during development
before that was removed.

Inside compose it reaches Postgres at `db:5432`, not `localhost` — `localhost`
in a container is the container. `docker-compose.yml` sets `DATABASE_URL`
accordingly, so nothing needs configuring for that path.

Either way it only reads the database the sniffer fills. It never captures
traffic, so the game does not need to be running.

## Status

**Working:** capture, TCP reassembly, adaptive deframing (seven candidate
layouts, locks on three consecutive valid parses), `Any` unwrapping,
signed-varint decoding, schema-vs-wire mismatch detection, every message
archived to `packets`, and marketplace prices (`price_list`) decoded into a
`prices` table with history.

**Known limits:** the obfuscated message keys rotate between client builds, so
the committed schema registry (built from a 2026-07-10 dump) does not describe
the current wire — a key that still resolves may name a different message
entirely. The decoder detects and flags the disagreement rather than printing
garbage. Message types are therefore identified empirically, by correlating
traffic with in-game actions or with values read off the screen — see
[keymap.json](#keymapjson--what-to-edit-when-the-game-updates) above. Runtime schema recovery via
Frida is implemented and proven on the chat service, but is blocked and unsafe
against a live client — see RUNBOOK part 3.

See RUNBOOK.md part 3 for the ordered list of what's next.

## Platform support

Capture is portable — it is libpcap, and works anywhere the binary runs
natively. Developed and verified on macOS (Darwin 25.5, Apple Silicon).

Two things are platform-bound:

- the **Frida tooling** in `sniffer/tools/` is macOS-specific;
- the **compose `sniffer` service captures on Linux only**, for the Docker VM
  reason described above.

## Legal

Passive observation of your own client's traffic, for interoperability
research. Not affiliated with Ankama. See [LICENSE](LICENSE).
