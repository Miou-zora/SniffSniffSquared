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
docker compose up -d          # postgres + pgadmin
cargo build
./target/debug/SniffSniffSquared --list                       # find your interface
./target/debug/SniffSniffSquared --dev en0 --all "tcp port 5555"
```

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

## Documentation

| file | what it covers |
|---|---|
| **[RUNBOOK.md](RUNBOOK.md)** | **Start here.** How the protocol works, a copy-pasteable command sequence, every trap, and what remains to be done. |
| [CLAUDE.md](CLAUDE.md) | Condensed orientation: ground truth, layout, conventions, traps. |
| [docs/observations.md](docs/observations.md) | Annotated real captures with byte-level analysis. |
| [tools/frida/README.md](tools/frida/README.md) | Runtime schema extraction routes. Partly stale — RUNBOOK.md supersedes it. |

## Layout

```
src/            the sniffer — capture, reassembly, deframing, decoding
proto/          messages.json (schema registry) + generated dofus3.proto
tools/          gen_proto.py, identify.py (correlate a message with an
                in-game action), replay.py, resign-debug-app.sh
tools/frida/    runtime schema extraction from the live client
docs/           captured-traffic analysis
reference/      IL2CPP dump + deobfuscation mappings (gen_proto.py inputs)
```

## Status

**Working:** capture, TCP reassembly, adaptive deframing (seven candidate
layouts, locks on three consecutive valid parses), `Any` unwrapping,
signed-varint decoding, schema-vs-wire mismatch detection, `kdh` (price list)
persisted to Postgres.

**Known limits:** the obfuscated message keys rotate between client builds, so
the committed schema registry (built from a 2026-07-10 dump) does not describe
the current wire — a key that still resolves may name a different message
entirely. The decoder detects and flags the disagreement rather than printing
garbage. Message types are therefore identified empirically, by correlating
traffic with in-game actions (`tools/identify.py`). Runtime schema recovery via
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
