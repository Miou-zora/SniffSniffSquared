# Contributing

Thanks for looking. This is a passive protocol-research project, so the first
section is about what belongs here at all — it matters more than the coding
conventions, and it is the one thing a pull request cannot be fixed into.

## Contents

- [What this project accepts, and what it does not](#what-this-project-accepts-and-what-it-does-not)
- [Before you write code](#before-you-write-code)
- [Getting set up](#getting-set-up)
- [The most valuable contribution: a key rotation](#the-most-valuable-contribution-a-key-rotation)
- [Adding a new message](#adding-a-new-message)
- [Test fixtures are real captured bytes](#test-fixtures-are-real-captured-bytes)
- [Privacy: never commit another player's data](#privacy-never-commit-another-players-data)
- [Code conventions](#code-conventions)
- [Commits and pull requests](#commits-and-pull-requests)
- [Documentation is part of the change](#documentation-is-part-of-the-change)

## What this project accepts, and what it does not

The project reads traffic that your own client already sends, on your own
machine, and decodes it. It connects to nothing, sends nothing, and modifies no
part of the game. That boundary is the project, not a disclaimer on it.

**In scope**

- Decoding: framing, reassembly, protobuf, schema recovery, message identification.
- Persistence and the `web/` dashboard built on captured data.
- Tooling that runs offline or read-side: the `tools/` scripts, DofusDB enrichment.
- Portability, tests, documentation, and the `blog/` series.

**Out of scope — these will be closed rather than reviewed**

- Anything that writes to the wire: packet injection, replaying frames at the
  live server, modified clients, proxies that alter traffic.
- Automation of play. No bots, no macro input, no "act on this message" hooks.
- Anything touching accounts or authentication: credential capture, session
  token reuse, logging in as anyone.
- Anti-cheat evasion, or work whose purpose is to avoid detection.
- Redistribution of Ankama assets — game binaries, asset bundles, the IL2CPP
  dump, extracted `.proto` files, or anything else copied out of the install.
  `tools/extract_nuggets.py` reads your local install and never writes to it;
  keep any new tooling on that side of the line.
- Capturing anyone else's traffic. Your own client, your own machine.

`sniffer/tools/frida/` is the one part that attaches to a client process, and it
attaches to a **re-signed copy** made by `resign-debug-app.sh`. It is for
recovering the message schema, and it is already known to crash the client
eventually. Never attach to a client anyone is playing on, and never propose
changes that make attaching part of the normal capture path.

## Before you write code

Read [`RUNBOOK.md`](RUNBOOK.md). It has the pipeline explanation, the verified
command sequence, and — the part that saves the most time — a list of dead ends
with the evidence that closed each one.

Several plausible ideas are already settled and measured. Re-opening one needs
new evidence, not a new argument:

- **The traffic is not encrypted.** Plaintext protobuf on TCP 5555. Output that
  looks like noise is a decode bug or a mis-joined schema, never a cipher.
  Confirm with `--raw`; you will see `type.ankama.com/...` in ASCII.
- **Static game data never crosses the wire.** Recipes, template stat ranges,
  anything a tooltip draws — it is in the client's data files. The server is
  asked only what it alone knows, which is prices. Three negative probes are
  written up in RUNBOOK part 1.
- **Recycling yield is not on the wire either**, and that search is finished:
  `kcr` is fully consumed by two fields, it is client-to-server, and a
  121-message session plus the whole archive contain no float or scaled integer
  matching an observed payout. It comes out of the asset bundles instead.
- **Messages are keyed by the `Any` type URL**, not by `Frame.Payload.id`. The
  `id` map is used nowhere in `sniffer/src/`.
- **`sniffer/proto/messages.json` is frequently mis-joined to the wire** — it
  describes a 2026-07-10 build whose keys the wire no longer uses. A name that
  still resolves may describe a different message entirely. The decoder flags
  the disagreement rather than trusting the schema, and so should you.

If you have evidence that overturns one of these, that is a genuinely valuable
issue. Bring the capture, the query and the numbers.

## Getting set up

The full setup, both the dashboard-only path and the capture path, is in the
README's [Quick start](README.md#quick-start). The short version:

```sh
cp .env.example .env          # KEEP THE QUOTES on BPF_FILTER
docker compose up -d          # postgres + pgadmin + web
```

The sniffer:

```sh
cd sniffer                    # it MUST be run from here — keymap.json,
cargo build && cargo test     # schema.json and proto/ resolve relative to cwd
```

The front end:

```sh
cd web
pnpm install
pnpm dev                      # http://localhost:3000
pnpm check                    # typecheck + lint + format — the gate
```

Two traps that have already cost time here:

- **`cargo test` does not rebuild `target/debug/SniffSniffSquared`.** Run
  `cargo build` before capturing, or you will analyse output from a stale binary.
- **`.env` needs `BPF_FILTER` quoted.** Unquoted, `dotenvy` stops parsing at the
  space and every variable declared after it — including `DATABASE_URL` —
  silently never loads. The symptom is no `[db] connected` line and no error.

You do not need the game to work on most of this. `tools/seed_sample.py` builds a
demo database, and `sniffer/tools/replay.py` pushes a recorded session over
loopback so the whole pipeline runs with no client. A seeded database is **not a
capture**: never measure the brisage model against one.

## The most valuable contribution: a key rotation

The obfuscated message keys rotate between client builds, and so do the field
numbers inside them. Measured across the 2026-08-04 update: of 141 keys seen
before and 91 after, 19 are shared, and all ten identified messages moved. So
after every game update the decoder goes partly blind until someone re-identifies
the keys, and that someone needs a client on the new build — which may well be
you and not the maintainer.

Nothing about this needs Rust. It is two JSON files:

1. Capture on the new build, then re-identify with the empirical tools — neither
   needs a schema:

   ```sh
   sniffer/tools/findvalue.py 75 326 6660 99999    # numbers read off one screen
   sniffer/tools/identify.py "open HDV and click several item prices"
   ```

2. Put the new tokens in [`sniffer/keymap.json`](sniffer/keymap.json) and the new
   field numbers in [`sniffer/schema.json`](sniffer/schema.json). Neither needs a
   rebuild.
3. Add a test over real bytes from the new build, and keep the old build's
   fixtures passing against `sniffer/testdata/schema-2026-07-10.json`. Two
   schemas, same parsers, real bytes from each — that suite is the guard, because
   a subtly wrong schema parses to something *plausible* rather than failing.

**Check for tokens that survived carrying a different meaning.** `iun` was
`inventory_add`; it is still on the wire and now carries pods,
`{1: current weight, 3: max}`. Left mapped, it would have written nonsense rather
than failing, which is the worse outcome. A mapping is only ever valid for the
build it was observed on — say which build in the pull request.

## Adding a new message

Four steps, worked through with `price_list` as the example in RUNBOOK part 2
step 6:

1. Name it in `messages::DEFAULTS` (`sniffer/src/messages.rs`). **Code refers to
   messages by semantic name, never by wire key** — that file is the only place a
   rotated key changes.
2. Describe its shape in `sniffer/schema.json`. Field numbers live there, not in
   Rust.
3. Parse it in `sniffer/src/interpret.rs`, matching on the *name*, and add it to
   `is_known_key`. Small adapters turn a `Node` into the typed struct.
4. Optionally persist it in `build_dispatch()` in `sniffer/src/main.rs`, via
   `messages::keymap().key("...")`. If it needs a table, add it to `init.sql`.

Then pin it with a test over real captured bytes.

**Structure is data; meaning is Rust.** "An empty ladder is not a price message",
"quantity absent means one", "a negative delta is a removal" — those are
decisions and they belong in `interpret.rs`. Field numbers are structure and they
belong in JSON.

## Test fixtures are real captured bytes

The fixtures in `sniffer/src/dump.rs`, `sniffer/src/interpret.rs` and
`sniffer/src/dispatch.rs` are bytes that came off the wire. Keep them byte-exact.

They have twice been invented by hand in this repository, and a hand-written
fixture proves the parser agrees with your idea of the protocol rather than with
the protocol. If you need bytes for a message you cannot capture, say so in the
pull request rather than constructing them.

## Privacy: never commit another player's data

Captures contain other people's character names and chat messages. Before a
fixture, a log excerpt or a screenshot goes into a commit, redact them —
`Player-Redacted-02` is the convention used in the README, and chat bodies get
replaced wholesale with `<chat message text>`.

Do not commit `.env`, database dumps, `backups/`, or anything under
`sniffer/reference/` that came out of the game install. The `.gitignore` already
covers the known cases; a new capture format is your responsibility.

## Code conventions

**Rust** (edition 2024)

- **No `unwrap()` on wire data.** Everything from the network is `Option` or
  `Result` and falls back to a heuristic. A malformed packet must never panic the
  capture: a sniffer that dies on a hostile frame loses the session.
- Module headers are `//!` doc comments explaining *why*, not *what*. Match the
  existing terse style.
- **When schema and wire disagree, prefer the wire and flag it.** See the
  `MISMATCH` tag in `sniffer/src/dump.rs`. A wrong schema is worse than none — it
  forces strings through the packed-int path and prints digit soup that looks
  like a decoder bug.
- `cargo fmt` and `cargo clippy` before pushing. `cargo test` is 74 tests.

**TypeScript / `web/`**

- Read `web/AGENTS.md` first. Next 16 differs from what most references describe,
  and the app's own guide points at `web/node_modules/next/dist/docs/`.
- `pnpm check` (typecheck + lint + format) is the gate before committing.
- `web/` reads from Postgres; it never writes to the tables the sniffer owns. It
  owns `item_marks`, `app_settings` and `craft_basket`.

**Python / `tools/`**

- Standard library plus `requests`. These are operator scripts, not a package.
- **The capture path takes no network dependency.** Enrichment from DofusDB is
  either an offline step in `tools/` or read-side in `web/`, so a DofusDB outage
  can never cost a packet. Do not add an HTTP call to anything the sniffer runs.

**Schema and data**

- Item ids are DofusDB ids, so `https://api.dofusdb.fr/items/<id>` resolves names
  and types with no mapping table.
- `item_stats` (what one instance rolled, off the wire) and `item_effects` (what
  the type can roll, from DofusDB) are different things. Do not conflate them.

## Commits and pull requests

Commits follow Conventional Commits with a scope, as in the history:

```
feat(web): compare selling a craft against recycling it
fix(blog): a nugget is an item with a price, not a currency
docs(blog): document the Medium preview banner in blog/medium/README.md
chore: add the writing skills, and note the one that phones home
```

Subject in the imperative, lower case, no trailing period. Scopes in use:
`sniffer`, `web`, `blog`, `logo`, `docs`, `tools`.

For pull requests:

- Branch off `main`; do not commit to `main` directly.
- One concern per pull request. A key rotation and a UI change are two.
- Run the gates that apply — `cargo test` for `sniffer/`, `pnpm check` for `web/`
  — and say in the description that you ran them, with the output if it is
  interesting. "It builds" has been claimed in this repository when it did not.
- Fill in the pull request template. The evidence section is the important one:
  for protocol work, that means the query, the capture and the counts.
- Say which client build you were on for anything protocol-related. A result
  without a build is not reproducible.

There is no CI yet, so the gates are yours to run.

## Documentation is part of the change

- `RUNBOOK.md` is the reference for protocol work. New findings, and new dead
  ends with the evidence that closed them, go there.
- `CLAUDE.md` carries the ground truth that stops facts being re-derived. If your
  change invalidates something in it, fix it in the same pull request.
- `blog/` is a narrative series over the same material, and **every number in it
  traces to a file here** — a fact that changes needs the post updated too.
  `blog/medium/` is generated; do not hand-edit it.
- `README.md` is the front door. Keep the numbers in it true.

## Questions

Open an issue. For anything sensitive, see [SECURITY.md](SECURITY.md). Everyone
taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
