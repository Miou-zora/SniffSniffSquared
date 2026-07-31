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
clear. (Names and addresses throughout this repo's examples are replaced with
placeholders; the byte sequences are otherwise real and self-consistent.) What *looks* like encryption is two separate things:

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
`sniffer/src/framer.rs` tries seven candidate layouts and locks whichever parses three
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
| `sniffer/src/main.rs` | pcap capture, link-layer strip, IPv4/IPv6, flags, DB wiring |
| `sniffer/src/flow.rs` | per-direction TCP reassembly (seq-aware, drops retransmits) |
| `sniffer/src/framer.rs` | adaptive deframing — the seven candidate layouts |
| `sniffer/src/frame.rs` | the `Frame` envelope |
| `sniffer/src/pb.rs` | schema-less protobuf wire reader |
| `sniffer/src/registry.rs` | loads `sniffer/proto/messages.json`, resolves a type token to a field list |
| `sniffer/src/dump.rs` | pretty-printer, `Any` unwrapping, schema-vs-wire checking |
| `sniffer/src/interpret.rs` | per-message meaning, dispatched on semantic name |
| `sniffer/src/messages.rs` | semantic name <-> wire key; the one place a rotated key changes |
| `sniffer/src/dispatch.rs` | callbacks per message key |

### What is actually known

| semantic name | wire key (this build) | meaning |
|---|---|---|
| `price_list` | `kea` | marketplace price ladder: x1 / x10 / x100 / x1000 |
| `chat_message` | `ksv` | chat / trade channel: author, timestamp, free text |
| `crush_result` | `kfy` | crushing an item into runes: yield %, and the runes (parsed, not stored) |
| `item_detail` | `kev` | item instance uid -> type id; joins the above to an item |

106 distinct keys observed in one session; `idd` is the most frequent and is
still unidentified. Code refers to messages by the left-hand column only — see
part 2 step 5 for what to do when the right-hand column changes.

> **The keys rotate between client builds.** `kdh` (documented as the price
> list), `kag` and `jqj` appear nowhere in an 861-message capture from the
> current build — only `ksv` carried over. A mapping is only valid for the
> build it was observed on, so `docs/observations.md` and the `kdh` interpreter
> describe a client that no longer exists. Re-identify with
> `sniffer/tools/identify.py` — see part 2 step 6.

> **Static game data is not on the wire — stop looking for it.** Recipes,
> template stat ranges and anything else a tooltip renders come from the
> client's own data files; the server is only asked for things it alone knows,
> which in practice means prices. Three probes, all negative, all on captures
> verified to span the action:
>
> - Opening an item's craft description (Chapeau du Vulkain, `12417`) sent
>   nothing containing its eight ingredient ids — searched 970 messages in the
>   window, in varint, zigzag, fixed32 and fixed64.
> - Its template ranges (`41..60`, `26..35`, `11..15`, ...) appear in no message
>   alongside the item id. `12417` occurs in exactly two message types across
>   23 790 messages: `iuz` and `khd`, neither of which carries stats.
> - Opening the job workshop produced `kqm` `0801` and `kqh` `0801` — a request
>   and its ack, two bytes each.
>
> What the click *does* produce is a `khb` price query per ingredient and a
> `kea` answer, which is why browsing a craft panel fills `prices` for exactly
> the ingredients you need. Recipes and ranges come from DofusDB instead —
> `tools/import_items.py` in bulk, and a cached read-time fetch in `web/` for
> anything the importer has not reached.

Two more keys identified while establishing that:

| semantic name | wire key (this build) | meaning |
|---|---|---|
| (unnamed) | `khb` | client asks the price of one item id |
| (unnamed) | `iuz` | 7 602 `item_id -> value` pairs, whole catalog, ~80 KB |
| (unnamed) | `khd` | every item id in the HDV category being browsed |

`kea` has two shapes: a short one carrying the x1/x10/x100/x1000 ladder, and a
long one listing the marketplace's actual offers — **each offer carries that
copy's rolled stats**, `{8: value, 9: effect_id}`. 1 726 such observations sat
unparsed in `packets` when this was found; the sniffer reads only the ladder.
That is the one wire source of stat values beyond `item_detail`, and it is a
sample of real copies, never a template.

Field *names* are unknown for the game protocol. `sniffer/proto/messages.json` gives
field **numbers** and **types** only, and describes the 2026-07-10 build.
Because of the rotation this is worse than "partly wrong": a key that still
resolves may now name a different message entirely. The `vars` and `packs`
columns in `packets` are derived from it and unreliable for the same reason —
**`body` is the ground truth.**

### The central problem: mis-joined schemas

`sniffer/proto/messages.json` is keyed by obfuscated C# class path (`ksx.ksw.ksv`).
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

Four of six observed keys were mis-joined in that capture. Note this was
measured *before* the key rotation was understood — since the registry
describes a build whose keys the wire no longer uses, rotation is likely the
larger cause, and these numbers are a lower bound rather than a diagnosis.
Either way the decoder *detects and reports* the disagreement rather than
silently printing garbage:

```
Any <type.ankama.com/ksv> [ksx.ksw.ksv] <!! schema mismatch on 3 fields>
  7: string "2026-07-29T16:21:53+02:00"  <!schema: declared long>
  8: string "Player-Redacted-02"         <!schema: declared bool>
  9: string "<chat message text>"        <!schema: declared packed, reads as text>
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
docker compose up -d          # from the repo root
docker exec dofus_db psql -U dofus -d dofus -c '\dt'   # expect: packets, prices
```

> **Trap — keep `BPF_FILTER` quoted.** `.env.example` now ships
> `BPF_FILTER="tcp port 5555"` with quotes, and it must stay that way. Unquoted,
> `dotenvy` stops parsing at the space, so every variable declared *after* it —
> including `DATABASE_URL` — is silently never loaded, and the sniffer runs with
> no database and no error message. Symptom: no `[db] connected` line and no
> failure either. Compose strips the quotes correctly, so one form works for
> both. If you copied `.env` before this was fixed, add the quotes.

### 2. Build

The Rust app lives in `sniffer/`. **Run it from there** — it resolves
`keymap.json` and `proto/messages.json` relative to the working directory.

```sh
cd sniffer
cargo build
cargo test          # 19 tests, all should pass
```

> **Trap.** `cargo test` does not refresh `target/debug/SniffSniffSquared`.
> Always `cargo build` before capturing or you will be running a stale binary
> and drawing conclusions from it.

### 3. Capture

> **Docker note.** `docker compose --profile capture up -d sniffer` runs the
> same binary in a container, but **only captures on Linux**. Docker on macOS
> and Windows runs containers in a Linux VM, so host networking attaches to the
> VM — the container sees `eth0`/`docker0`, never `en0`, and captures nothing
> while looking healthy. Verified: `--list` inside the container returns only
> virtual interfaces. Use the native commands below on those platforms.

Start the game, then, **from `sniffer/`**:

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

**Every** message is archived to `packets`, interpreted or not, via
`Dispatcher::on_any` (`ARCHIVE_PACKETS=0` disables). That archive is what makes
message identification possible without being in-game at the moment a message
appears.

The `kdh` table is separate, written by a keyed handler in `build_dispatch()`.
**It no longer fires** — `kdh` is a stale key that this build does not use. Its
schema also keys on the first varint with an upsert, so it holds only the
latest row per id, not history.

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

Every message that arrives is also archived to the `packets` table, whether or
not it has an interpreter (`ARCHIVE_PACKETS=0` disables it). That is what lets
you work on a message type later without being in-game when it appears.

### 5. When a message stops decoding — repointing a rotated key

The obfuscated wire keys change between client builds, so this is routine
maintenance rather than a failure. Nothing in `sniffer/src/` refers to a message by its
wire key: code says `price_list`, and `sniffer/src/messages.rs` is the only place that
knows the current key is `kea`.

**To repoint a message, edit `sniffer/keymap.json`. No rebuild:**

```json
{
  "price_list": "kea",
  "chat_message": "ksv"
}
```

Change the value to the new key, restart the sniffer, and confirm the startup
line:

```
[*] message keymap: 3 entries (2 from keymap.json) — chat_message=ksv price_list=kea ...
```

Entries in that file override the built-in `messages::DEFAULTS`; anything
omitted falls back to them, and `_`-prefixed entries are treated as comments.
Editing `DEFAULTS` instead is equivalent but needs a rebuild — do that when the
new key is confirmed and worth committing.

To find the new key, use step 6.

### 6. Identifying a message

Since the keys rotate, identification is empirical: watch the archive while
doing one specific thing in game, and see what appears that was not there
before. `sniffer/tools/identify.py` automates the diff.

```sh
# terminal 1 — sniffer running with DATABASE_URL, so `packets` fills
# terminal 2
sniffer/tools/identify.py "open HDV and click several item prices"
```

It samples a quiet baseline, waits for you to perform the action, then reports
keys that are new or spiked above background. Run it two or three times for the
same action — keys that appear *every* time are the match; background chatter
varies between runs.

Then inspect the candidate's payload:

```sh
docker exec dofus_db psql -U dofus -d dofus -c \
  "SELECT captured_at, src, encode(body,'hex') FROM packets WHERE msg_key='<key>' ORDER BY id DESC LIMIT 5;"
```

Direction is a strong hint on its own: client→server messages are your actions,
server→client are world state.

To wire a confirmed message in, in this order:

1. **Name it** in `sniffer/src/messages.rs` `DEFAULTS` — a stable semantic name plus
   the current wire key, e.g. `("guild_info", "abc")`. Everything downstream
   uses the name, so a future rotation is a one-line change here.
2. **Parse it** in `sniffer/src/interpret.rs`: a function returning a typed struct, and
   an arm in `interpret()` matching on the *semantic name*. Parse the body
   structurally with `pb::Reader`; do not go through the schema registry, which
   is keyed to an older build.
3. **Persist it**, optionally, with a handler in `build_dispatch()`
   (`sniffer/src/main.rs`), registered via
   `messages::keymap().key("guild_info")` rather than a literal key.
4. **Pin it** with a test over real captured bytes, as
   `interpret::tests::price_list_decodes_the_ladder` does.

`price_list` is the worked example of all four steps.

### 7. Testing without the game

`sniffer/tools/replay.py` pushes captured frames over loopback so the whole pipeline —
deframing, `Any` unwrapping, interpreters, callbacks, database writes — runs
without launching the client:

```sh
# terminal 1
DATABASE_URL='postgres://dofus:change_me@localhost:5432/dofus' \
  ./target/debug/SniffSniffSquared --dev lo0 --all "tcp port 5555"
# terminal 2
sniffer/tools/replay.py --count 5          # or --hex <frame bytes> for another message
```

Note `--dev lo0`, not `en0`. Send at least three frames or the deframer never
locks a layout.

To add another message: register a handler in `build_dispatch()`
(`sniffer/src/main.rs`), keyed by the `Any` type key. `e.values` gives you the varints
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

`sniffer/tools/frida/probe.ts` is a fast diagnostic (seconds, not minutes). Run it with
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

**Status: the method is proven, the game protocol is still blocked.**

The extraction approach was rewritten and works. Rather than walking
FieldDescriptors (~8 bridge invokes per field, ~184k total, never finished),
`agent.ts` now pulls each loaded `.proto` file's serialized
`FileDescriptorProto` via `FileDescriptor.ToProto()` — one blob per *file*,
carrying real message names, real field names, numbers, types and nesting.
`sniffer/tools/parse_descriptors.py` turns those blobs into a registry.

Proven end-to-end on the chat service, 51 messages with real names:

```
channel.ChannelMessage
  1  message_id          string
  2  channel_id          string
  3  created_timestamp   long
  4  content             string
  5  author              user.User
```

**The blocker, now diagnosed.** Invoking the descriptor getter on *any*
`Ankama.Dofus.Protocol.Game` class deadlocks. The process drops to idle CPU
and never returns.

First, a measurement trap that invalidated every earlier reading:
**`console.log` output is queued during synchronous agent execution and only
delivered once the script yields; `send()` is delivered live.** A working scan
and a hung one looked identical because all the progress logging used
`console.log`. Any diagnostic here must use `send()`.

With `send()` heartbeats the picture is exact:

```
[hb] start                        scanned=0   msgs=0  files=0
[hb] Ankama.Dofus.Protocol.Game   scanned=7   msgs=0  files=0  INVOKING hdx
   <nothing further, CPU idle>
```

It blocks on class 7 (`hdx`). Adding `hdx` to a skip list moves the block to
`hdy` — so it is the shared static initialisation behind these classes, not one
bad class, and skipping will not converge.

Ruled out, each tested on its own:

| tried | result |
|---|---|
| deferred via `setTimeout` (free thread) | blocks |
| deferred with `Il2Cpp.perform(..., "main")` | blocks |
| binary `send(payload, data)` | blocks |
| hex payload, O(n) encoder | blocks |
| synchronous at top level | blocks |
| skip the offending class | blocks on the next one |
| seed directly from `ksv`, no class scan | blocks |
| second attach to the same process | blocks |
| let the client sit idle for minutes first | blocks |

**A root cause found late, which invalidates earlier readings.** The re-signed
copy was being launched from a scratch directory. Dofus resolves its
Addressables catalogs relative to the launch directory, so it failed at boot:

```
ERROR [Addressables] (AddressableUtility:118) - Unable to find catalog list
Core.DataCenter.DataCenterModule:LoadData()
```

A window opens, so it looks like a working client — but `DataCenter` never
loads and **no per-frame method ever runs**. Any conclusion drawn from a copy
launched outside `/Applications/Ankama/Dofus-dofus3` is unreliable, including
the "let the client settle" test above and an early hook probe that reported
zero callbacks.

`sniffer/tools/resign-debug-app.sh` now installs the copy beside the original and
prints the required `cd`. Always confirm a boot before trusting a scan:

```sh
grep -c "Unable to find catalog list" ~/Library/Logs/Ankama/Dofus/Player.log  # want 0
tail ~/Library/Logs/Ankama/Dofus/Player.log                                   # want EventSystem:Update()
```

**Running on a game thread changes the failure mode.** With a properly booted
client, hooking `UnityEngine.EventSystems.EventSystem.Update` and doing the
extraction inside the hook — so the code runs on the game's own thread, where
the class-init lock is already ours — gets past the first seed:

```
[hb] seed  INVOKING ksv
[hb] seed  SKIP ksv threw        <- throws instead of deadlocking
[hb] seed  INVOKING jrj          <- and the scan CONTINUES
```

`ksv` now raises an exception rather than hanging, and the loop moves on.
`jrj` still deadlocks (whole process to 0% CPU, since the hook occupies the
main thread). So thread context was a real part of the problem but not all of
it.

**The client must be launched the way Zaap launches it.** Beyond the working
directory, it needs Zaap's arguments — a per-launch session hash and the IPC
port back to the launcher:

```sh
./Dofus-debug.app/Contents/MacOS/Dofus \
  --logfile ~/Library/Logs/zaap/dofus-dofus3/dofus-debug.log \
  --port 26116 --gameName dofus --gameRelease dofus3 --instanceId 2 \
  --hash <uuid> --canLogin true --langCode fr \
  --autoConnectType 1 --connectionPort 5555 --hdReady --4kReady --enableRetina
```

Capture a live `--hash` and `--port` by starting the game from the launcher and
reading its command line:

```sh
ps -Ao pid=,comm= | awk '/MacOS\/Dofus$/ {print $1}' | head -1 | xargs -I{} ps -o command= -p {}
```

Use a different `--instanceId` and `--logfile` so the debug copy runs alongside
your real client instead of disturbing it. The hash is reusable concurrently —
verified. With this the copy boots properly (0 catalog errors,
`EventSystem:Update()` in the log).

**Where it stands: invoking the descriptor getter is unsafe in every context
tried.**

| context | client state | result |
|---|---|---|
| injected thread, sync | broken boot (no catalogs) | probe read `ksv` FullName — the only success |
| injected thread, sync | properly booted | deadlock, process idle |
| inside `EventSystem.Update` hook | properly booted, standalone | `ksv` threw, scan continued, `jrj` deadlocked |
| inside hook | properly booted, Zaap args | **hard process crash** at `ksv` |

The crash is at process level, not a C# exception — which is why the handler
never reported anything to catch. `libc++abi: terminate_handler unexpectedly
returned` appears in the player log.

**Attaching to a live, logged-in client crashes it. Do not do this.**

Harvesting from a logged-in session worked mechanically — but the client
segfaulted a few minutes later, mid-play. The crash report names the cause:

```
External Modification Warnings:  Thread creation by external task.
  task_for_pid: 4   thread_create: 1

Thread 0 Crashed:: com.apple.main-thread
0   ???                 0x360b050d4  ???          <- PC not in any mapped region
1   libunwind.dylib     _Unwind_RaiseException + 408
2   libc++abi.dylib     __cxa_throw + 84
3   GameAssembly.dylib  ...
```

IL2CPP threw a managed exception, the C++ unwinder walked the stack and jumped
to garbage. Frida's injected thread and patched frames break unwind info, and
IL2CPP throws routinely during normal play, so this is a matter of when rather
than if. The instrumentation is not safe to leave attached to a session anyone
cares about.

Practical consequence: the heap harvest only sees descriptors the client has
already built, which needs a logged-in session, and instrumenting a logged-in
session destabilises it. Those two requirements are in direct tension, which is
what makes this route a poor trade rather than merely difficult.

If it is picked up again, the least-bad shape is: log in, harvest immediately,
accept that the client will likely die, and treat each session as one shot.

Next, if continuing anyway: **stop calling the getter altogether.** Every failure comes from forcing the static constructor. Read the
descriptor out of the already-initialised object graph instead —
`MessageDescriptor` exposes `<Proto>k__BackingField`, `<Fields>k__BackingField`
and friends as plain fields (confirmed by probe). Reading a field runs no user
code and cannot deadlock or crash the runtime the way an invoke can. Only
classes the game has already initialised will have non-null values, which is
fine: seed from messages seen on the wire during a real session.

Worth checking at the same time: log which method `descriptorGetter` actually
selects for `ksv`. The class has both `coma` (static) and `comb` (instance)
returning `MessageDescriptor`; if the selection is wrong, the crash may be an
ordinary calling-convention mismatch rather than anything about initialisation.

### 2. Re-join the registry on real names

`sniffer/tools/parse_descriptors.py` already emits `sniffer/proto/messages.runtime.json` keyed
by protobuf `FullName` — the same token the wire puts in the `Any` URL — so the
guesswork join from the obfuscated C# class leaf disappears. What is missing is
only the game-protocol half of the input (item 1).

Once that lands, point `Registry::load` at the runtime registry, preferring it
and falling back to `messages.json` for anything it lacks. Success metric
already exists: the `<!! schema mismatch on N fields>` count should go to zero.

### 3. Regenerate `dump.cs` — DONE, and it does not help

`dump.cs` is 64 MB so it is gitignored, not committed. Recover it by extracting
`dump.cs` from the Il2CppDumper zip into
`sniffer/reference/il2cpp-dump-20260710/`, then run `sniffer/tools/gen_proto.py`. Verified: it
reproduces the committed `sniffer/proto/messages.json` byte-for-byte, so the static
pipeline is reproducible and the committed artifact is trustworthy.

**A fresh dump would not fix the mismatches.** The theory was that
`messages.json` had drifted from the updated client. It has not — all 2204
obfuscated leaf tokens in the registry are still present in the *current*
`global-metadata.dat`:

```
obfuscated leaf tokens in messages.json: 2204
still present in CURRENT global-metadata.dat: 2204
missing (drifted): 0 = 0.0%
```

So do not spend time running Il2CppDumper against the current binary expecting
the mismatch count to drop. The mismatch is **semantic**: the `Any` type URL key
is not the same identifier as the obfuscated C# class leaf, so joining them by
last dotted segment is wrong regardless of how fresh the dump is. Only the
runtime descriptor route (item 1) resolves it, because `FullName` and the field
list come from the same object.

Note `jpp` and `kqh` appear on the wire but have no entry in the registry at
all, which is the same problem seen from the other side.

### 4. Wire up the `packets` table — DONE

Every message is now archived, interpreted or not, via `Dispatcher::on_any`.
The raw `body` is the point: a schema recovered later can be applied to
traffic captured today, so identifying a message no longer requires being
in-game at the moment it appears.

```sql
SELECT src, dst, msg_key, length(body), vars, packs FROM packets ORDER BY id;
```

Set `ARCHIVE_PACKETS=0` to turn it off. It uses its own Postgres connection
(`postgres::Client` is not shareable), and insert failures are rate-limited to
one line per 100 so a broken database cannot drown the capture.

Still unused: the `decoded` JSONB column, which is left NULL.

### 5. Identify `iuz` — probably the whole marketplace in one message

Three observed in one session, all server→client, **68–80 KB each** — two to
three orders of magnitude larger than anything else on the wire.

It matched all four prices of a single item during known-plaintext search
(`sniffer/tools/findvalue.py 75 326 6660 99999`), alongside the 25-byte `price_list`.
So it carries price data too, but in bulk. The obvious reading is a catalogue
sync: the full marketplace, or a whole category, in one payload.

If that is what it is, it is worth more than `price_list`: one message would
populate the entire `prices` table instead of one item per click.

Approach:

```sh
# when does it arrive? entering the HDV, changing category, first login?
sniffer/tools/identify.py "enter the HDV and switch category"

# pull one and look at the top-level shape
docker exec dofus_db psql -U dofus -d dofus -t -A -c \
  "SELECT encode(body,'hex') FROM packets WHERE msg_key='iuz' ORDER BY length(body) DESC LIMIT 1;"
```

Expect a repeated field of per-item submessages. If each element looks like the
inner part of `price_list` (item id + a 4-element packed ladder), the existing
`interpret::price_list` parser can likely be reused per element.

### 6. Identify `idd`

88 observed, all server→client, 15–166 bytes. Not the most frequent key — that
is `iwa` (1586), `jri` (1569), `jrj` (1250), `kmw` (1163) over 7057 messages —
but small, one-directional and frequent enough to be something structural
(entity state, a tick, an inventory delta).

Being server-only means it is world state rather than a player action, which
narrows what to correlate against. Use `sniffer/tools/identify.py` with a single
deliberate action and watch whether it spikes; if it fires constantly
regardless, it is a heartbeat or entity update and the size distribution
(15 vs 166 bytes) is the thing to explain.

The higher-volume keys above are better targets if the goal is understanding
the session rather than this particular message.

### Resolved: item ids are DofusDB ids

`prices.item_id` can be looked up directly at `https://api.dofusdb.fr/items/<id>`
— no mapping table needed. Verified: id `2609` returns "Carapace Verte", the
item whose prices were read off the screen when `price_list` was identified,
and its `typeId` `107` matches the `category` the sniffer decodes. All six
captured ids resolve, all of type "Alliage", consistent with browsing one HDV
category.

This closes the "item names" question: the sniffer stores ids only, and the web
app enriches at read time. Keeping the network dependency out of the capture
path means a DofusDB outage degrades the UI rather than interrupting
collection.

### Resolved: the crush focus is in `crush_request`

`crush_result` does not carry the focus. `crush_request` (`ker`) does, in
field 1, which is **absent** when no focus is set:

```
1=125 4=1 5=1     Baton d'Oubli, focus Vi
      4=1 5=1     Arc Anum,      no focus     <- field 1 missing
1=125 4=1 5=2     Anneau Bsene,  focus Vi
```

`125` is the rune's **effect id**, not its item id. DofusDB confirms: Rune Vi
(item 1523) has `effectId` 125, Rune Ine 126, Rune Age 119. One effect id spans
several runes — 125 covers Rune Vi, Rune Pa Vi and Rune Ra Vi.

**It is decoded for display but not stored.** The focus does not affect the
yield: the same item crushed with any focus, or none, returns the same
coefficient. Only the yield varies per crush, so `crushes` records only
`item_id` and `yield_percent`.

Two corrections this produced, both worth knowing:

- **`kch` puts an item into the breaker; it does not crush it.** A `kch` with no
  crush following produced only an `item_detail` and no result — the item sat in
  the slot while the focus was changed. The actual trigger is `ker`. The full
  sequence is: `kch` (place) -> `kev` (details) -> ... -> `ker` (crush) ->
  `ivf` (removed) -> `kfy` (result).
- **Toggling focus in the UI sends nothing.** A capture across four deliberate
  focus changes contained only heartbeats; the focus is transmitted with the
  crush command, not when it is chosen. An experiment designed to watch the
  toggles was therefore looking in the wrong place — the answer was already in
  the original crush captures.

Fields 4 and 5 of `crush_request` vary (1/1, 1/1, 1/2) and remain unexplained.

### Dead ends — do not repeat these

- **`esg` is not the id-map class in this build.** Its fields are
  `dqti: Dictionary<Int32, esg.ActivityData>` and `dqtj: esg.Data`. The `esg` /
  RVA `0x1AF2A50` references in `sniffer/tools/frida/README.md` and `gen_proto.py` are
  stale. Less important than it looks: the wire uses `Any` type URLs, not
  `Payload.id`, so the descriptor `FullName` is the join that matters.
- **There are no embedded `FileDescriptorProto` blobs to scrape.**
  `GameAssembly.dylib` contains zero occurrences of `.proto`.
  `stringliteral.json` has two, both tiny and irrelevant. The 102 `.proto` hits
  in `global-metadata.dat` are false positives from the substring in
  `com.ankama.dofus.protocol.game`. Descriptors are reachable at runtime only.
- **`sudo` does not solve the Frida attach failure.** Hardened runtime without
  `get-task-allow` blocks root too. Re-sign a copy, or disable SIP.
