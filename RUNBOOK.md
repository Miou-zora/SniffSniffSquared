# SniffSniffSquared — how to read Dofus 3 packets

Written for someone arriving cold. Part 1 explains what the traffic is and how
far the decode gets. Part 2 is a copy-pasteable sequence. Part 3 is the work
that is *not* done yet.

Everything in Part 2 has been run on macOS (Darwin 25.5, Apple Silicon) and
works, except where explicitly marked **UNVERIFIED**.

---

## Part 1 — what you are looking at

### The traffic is not encrypted

This is the first thing people get wrong. Dofus 3 talks plaintext protobuf over
TCP port 5555. A raw hexdump shows readable ASCII:

```
0040  02 42 01 0b 12 12 50 6c 61 79 65 72 2d 52 65 64   .B....Player-Red
0050  61 63 74 65 64 2d 30 31 1a 30 0a 18 e9 b6 96 0f   acted-01.0......
```

Player names, guild names, chat text and ISO timestamps all arrive in the
clear. What *looks* like encryption is two separate things:

1. **Obfuscation.** Message type names are three-letter tokens (`kdh`, `ksv`,
   `jrj`). That is Ankama's build obfuscation, not a cipher.
2. **Decode bugs.** A wrong schema turns a string into a list of integers, and
   an unsigned read turns `-20002` into `18446744073709531614`. Both are fixed
   (see below), but they made the output look like noise.

### The wire format

```
TCP stream
  └─ length-prefixed frame          (varint length, no self-inclusion, no lead skip)
      └─ Frame  (Ankama.SpinConnection)
          oneof { Request=1, Response=2, Payload event=3 }
          Payload { int32 id = 1; bytes data = 2; }
          └─ google.protobuf.Any
              type_url = "type.ankama.com/<key>"   ← e.g. "type.ankama.com/ksv"
              value    = <the actual message bytes>
```

The framing header width was not recoverable from the static dump, so
`src/framer.rs` tries seven candidate layouts and locks whichever parses three
consecutive valid messages. On this build it always resolves to:

```
framing locked: Varint includes_self=false lead_skip=0
```

**Messages are identified by the `Any` type URL, not by `Payload.id`.** This
matters: a lot of the older tooling chases the `id` map, which the current code
never uses.

### The decode pipeline

| file | job |
|---|---|
| `src/main.rs` | pcap capture, link-layer strip, IPv4/IPv6, flags, DB wiring |
| `src/flow.rs` | per-direction TCP reassembly (seq-aware, drops retransmits) |
| `src/framer.rs` | adaptive deframing — the seven candidate layouts |
| `src/frame.rs` | the `Frame` envelope |
| `src/pb.rs` | schema-less protobuf wire reader |
| `src/registry.rs` | loads `proto/messages.json`, resolves a type token to a field list |
| `src/dump.rs` | pretty-printer, `Any` unwrapping, schema-vs-wire checking |
| `src/interpret.rs` | per-message meaning. Only `kdh` is implemented |
| `src/dispatch.rs` | callbacks per message key |

### What is actually known

- `kdh` = price list. Decodes correctly.
- `ksv` = chat / listing messages (contains free text, author, timestamp).
- `iwa`, `jri`, `jrj`, `kmw`, `knh`, `jpp`, `kqh` = seen on the wire, unlabelled.

Field *names* are unknown for the game protocol. `proto/messages.json` gives
field **numbers** and **types** only.

### The central problem: mis-joined schemas

`proto/messages.json` is keyed by obfuscated C# class path (`ksx.ksw.ksv`).
The wire gives an `Any` key (`ksv`). `registry.rs` joins them by matching the
last dotted segment. **That join is often wrong.** Measured over one capture:

| key | mismatched fields |
|---|---|
| `ksv` | 3 |
| `jrj` | 1 |
| `kmw` | 1 |
| `jri` | 1 |
| `iwa` | 0 — clean |
| `kdh` | 0 — clean |

Four of six observed keys are mis-joined. The decoder now *detects and reports*
this rather than silently printing garbage:

```
Any <type.ankama.com/ksv> [ksx.ksw.ksv] <!! schema mismatch on 3 fields>
  7: string "2026-07-29T16:21:53+02:00"  <!schema: declared long>
  8: string "Player-Redact02"            <!schema: declared bool>
  9: string "<chat message text>" <!schema: declared packed, reads as text>
```

Two guards produce that. A **wire-type** check (declared `long`, wire is
length-delimited → contradiction, drop the declaration). And a **content**
check, because a packed integer array and a string are *both* length-delimited
— the wire type alone cannot tell them apart, so printable bytes under a packed
declaration are treated as text. That second one is what rescued the chat
strings from `packed [112, 108, 97, ...]`.

Fixing the join at the root is Part 3.

---

## Part 2 — run it

### 0. Prerequisites

```sh
brew install --cask docker        # or Docker Desktop
rustup default stable
pipx install frida-tools          # only for Part 2.5
```

You must be in the `access_bpf` group to capture without sudo. Check:

```sh
id -Gn | tr ' ' '\n' | grep access_bpf   # prints "access_bpf" if you are
ls -l /dev/bpf0                          # crw-rw---- root access_bpf
```

If absent, prefix the capture commands with `sudo`.

### 1. Database

```sh
cp .env.example .env
$EDITOR .env
docker compose up -d
docker exec dofus_db psql -U dofus -d dofus -c '\dt'   # expect: kdh, packets
```

> **Trap — quote `BPF_FILTER`.** `.env.example` ships
> `BPF_FILTER=tcp port 5555` unquoted. `dotenvy` stops parsing at the space,
> so every variable *after* that line — including `DATABASE_URL` — is silently
> never loaded, and the sniffer runs with no database and no error message.
> Write `BPF_FILTER="tcp port 5555"`. `BPF_FILTER` is read from argv anyway,
> never from the environment.

### 2. Build

```sh
cargo build
cargo test          # 10 tests, all should pass
```

> **Trap.** `cargo test` does not refresh `target/debug/SniffSniffSquared`.
> Always `cargo build` before capturing or you will be running a stale binary
> and drawing conclusions from it.

### 3. Capture

Start the game, then:

```sh
# what the decoder understands (has an interpreter)
./target/debug/SniffSniffSquared --dev en0 "tcp port 5555"

# every frame, decoded — this is the useful one for exploring
./target/debug/SniffSniffSquared --dev en0 --all "tcp port 5555"

# raw hexdump, no parsing — use when you distrust the deframer
./target/debug/SniffSniffSquared --dev en0 --raw "tcp port 5555"

./target/debug/SniffSniffSquared --list      # find your interface
```

Sanity check: within seconds you should see, once per direction,

```
[a.b.c.d:5555 -> w.x.y.z:NNNNN] framing locked: Varint includes_self=false lead_skip=0
```

No such line means the deframer never locked — the traffic is not what we think
it is, or the BPF filter caught the wrong flow.

### 4. Database writes

Only `kdh` is wired to the database, via `build_dispatch()` in `src/main.rs`.
The `packets` table in `init.sql` is **created but never written to** — nothing
in `src/` references it.

```sh
DATABASE_URL='postgres://dofus:change_me@localhost:5432/dofus' \
  ./target/debug/SniffSniffSquared --dev en0 --all "tcp port 5555"
```

Expect `[db] connected; kdh -> table kdh` on startup. If that line is absent
and there is no error either, `DATABASE_URL` did not reach the process — see
the `BPF_FILTER` trap above.

```sh
docker exec dofus_db psql -U dofus -d dofus -c 'SELECT * FROM kdh ORDER BY updated_at DESC LIMIT 20;'
```

`kdh` messages only appear when price data flows — open the market/HDV in game.

To add another message: register a handler in `build_dispatch()`
(`src/main.rs`), keyed by the `Any` type key. `e.values` gives you the varints
and packed arrays already decoded.

### 2.5 Recovering real schemas with Frida — **PARTIALLY VERIFIED**

This recovers real message names, field names, numbers and types from the live
client. Everything below has been executed and works *except the full scan,
which has never been run to completion* — see Part 3.

The client is signed with the hardened runtime and no `get-task-allow`, so
under SIP **nothing can attach to it, including root**. `sudo frida` fails with
`PermissionDeniedError`. Make a debuggable copy instead:

```sh
./tools/resign-debug-app.sh
# -> build/Dofus-debug.app, ad-hoc signed with get-task-allow added.
#    Your real install is not modified.
```

Launch the copy and attach. **No login needed** — the descriptors are static
and readable at the login screen.

```sh
build/Dofus-debug.app/Contents/MacOS/Dofus &
# wait ~15s for the IL2CPP runtime, note the pid
~/.local/pipx/venvs/frida-tools/bin/python tools/frida/run.py -p <pid>
```

Output: `/tmp/dofus_protocol.json`.

Rebuild the agent after editing `agent.ts`:

```sh
cd tools/frida && npx frida-compile agent.ts -o agent.js
```

`tools/frida/probe.ts` is a fast diagnostic (seconds, not minutes). Run it with
`run.py -p <pid> -a probe.js` when the main agent finds nothing — it prints
each class's interfaces, its descriptor/parser methods, and candidate id
dictionaries.

> **Trap — the scan freezes the client.** It runs on the game's own threads at
> 100%+ CPU for its whole duration. The window stops responding and will not
> quit. That is expected, not a crash. Never run it against a client you are
> playing on. To abort: kill the `run.py` process, then the game pid.

> **Trap — obfuscated accessors.** Do not look up `get_Descriptor` /
> `get_Parser` by name. In `Ankama.Dofus.Protocol.Game` they are obfuscated
> along with everything else (`ksv` exposes them as `coma` and `colz`). Looking
> them up by name silently finds **zero** messages across 5644 classes while
> appearing to work, because the unobfuscated chat-service assembly still
> matches. `agent.ts` now matches on signature — a static, zero-argument method
> returning `MessageDescriptor` — which is stable across obfuscation.

What the descriptors give you, confirmed on the unobfuscated chat service:

```
channel.DeleteChannelCmd  ->  channel_id (1, String), member_user_id (2, Int64)
```

---

## Part 3 — not done yet

Ordered by value.

### 1. Finish the Frida scan

Never completed. Killed at ~25 minutes, still running. The cost is
`readFields()` in `agent.ts`: roughly six IL2CPP bridge invokes per field
across ~2300 messages, each costing milliseconds, all on the game's threads.

Three changes should make it practical:

- **Scope it.** Only `Ankama.Dofus.Protocol.*` and `Core` produced messages;
  the other ~30 000 classes contributed nothing but time.
- **Drop unused invokes.** `messages.json` needs number + type + repeated.
  `get_IsMap` and the `ref` lookups can go.
- **Stream results out incrementally**, so a kill mid-scan still yields partial
  data instead of nothing.

### 2. Re-join the registry on real names

Once the scan lands, `messages.json` can be keyed by the descriptor's
`FullName` — the same token the wire puts in the `Any` URL — instead of
guessing from the obfuscated C# class leaf. That fixes the four mis-joined keys
at the root. Success metric already exists: the `<!! schema mismatch on N
fields>` count should go to zero.

### 3. Regenerate `dump.cs`

`tools/gen_proto.py` reads `reference/il2cpp-dump-20260710/dump.cs`, **which is
not in the repo** — only `DummyDll/` and the Ghidra scripts were committed. So
`proto/messages.json` is a frozen artifact from a July 10 dump that cannot
currently be regenerated, while the client has updated since. Running
`gen_proto.py` now exits with instructions. Re-run Il2CppDumper against the
current `GameAssembly.dylib` + `global-metadata.dat`, drop `dump.cs` into that
folder, then re-run `gen_proto.py`.

### 4. Wire up the `packets` table

`init.sql` defines it with exactly the columns the pipeline already has in hand
at `handle_tcp` (`src`, `dst`, `msg_key`, `body`, `vars`, `packs`, `decoded`).
Nothing inserts. This is the raw-capture archive that was designed and never
connected.

### Dead ends — do not repeat these

- **`esg` is not the id-map class in this build.** Its fields are
  `dqti: Dictionary<Int32, esg.ActivityData>` and `dqtj: esg.Data`. The `esg` /
  RVA `0x1AF2A50` references in `tools/frida/README.md` and `gen_proto.py` are
  stale. Less important than it looks: the wire uses `Any` type URLs, not
  `Payload.id`, so the descriptor `FullName` is the join that matters.
- **There are no embedded `FileDescriptorProto` blobs to scrape.**
  `GameAssembly.dylib` contains zero occurrences of `.proto`.
  `stringliteral.json` has two, both tiny and irrelevant. The 102 `.proto` hits
  in `global-metadata.dat` are false positives from the substring in
  `com.ankama.dofus.protocol.game`. Descriptors are reachable at runtime only.
- **`sudo` does not solve the Frida attach failure.** Hardened runtime without
  `get-task-allow` blocks root too. Re-sign a copy, or disable SIP.
