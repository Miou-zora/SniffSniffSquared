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

## Quick start

```sh
cp .env.example .env          # then quote BPF_FILTER — see RUNBOOK.md
docker compose up -d          # postgres + pgadmin, from the repo root

cd sniffer                    # the Rust app; run it from here
cargo build
./target/debug/SniffSniffSquared --list                       # find your interface

# capture, decode, and write prices + a full message archive to Postgres
DATABASE_URL='postgres://dofus:change_me@localhost:5432/dofus' \
  ./target/debug/SniffSniffSquared --dev en0 --all "tcp port 5555"
```

Marketplace prices land in the `prices` table, one row per observation:

```sh
docker exec dofus_db psql -U dofus -d dofus -c \
  'SELECT seen_at, item_id, b1, b10, b100, b1000 FROM prices ORDER BY seen_at DESC LIMIT 10;'
```

Every message is archived to `packets` whether or not it is understood, so a
message identified later can be decoded from traffic captured today.

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

web/                 (not yet) Next.js front end over the same Postgres
```

`sniffer/` writes to Postgres; anything else reads from it. That is the only
coupling between apps, which keeps them independently runnable.

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

## Requirements

macOS (the Frida tooling is macOS-specific; capture is portable). Rust stable,
Docker, and `pipx install frida-tools` for schema recovery. Capture needs
membership in `access_bpf`, or `sudo`.

## Legal

Passive observation of your own client's traffic, for interoperability
research. Not affiliated with Ankama. See [LICENSE](LICENSE).
