# Captured traffic — raw observations

Consolidated from the original `notes.md` / `notes2.md` / `notes3.md` /
`notes4.md` scratch files, annotated with what is now understood. These are
real captures from a live session; keep them as decoder regression material.

Two of these byte sequences are used verbatim as test fixtures — see
`BODY` in `src/dump.rs` and `KDH` in `src/dispatch.rs`. Don't "tidy" them.

---

## What these dumps established

- The wire is **plaintext protobuf**. `type.ankama.com/...` is readable ASCII
  in every frame.
- The message key is the `Any` type URL suffix (`kag`, `kdh`, `jqj`), not
  `Payload.id`.
- Frames are varint-length-prefixed, header excluded from the count.

## Message keys seen here

| key | meaning |
|---|---|
| `kdh` | price list (**decoded correctly**, has an interpreter) |
| `kag` | client → server, request-shaped; sent repeatedly with small varints |
| `jqj` | server → client, carries a large negative varint |

Later captures (see `RUNBOOK.md`) added `ksv` (chat/listings), `iwa`, `jri`,
`jrj`, `kmw`, `knh`, `jpp`, `kqh`.

---

## Client → server: `kag`

```
[192.0.2.10:49788 -> 203.0.113.5:5555] seq=2809242277 len=42
  0000  29 22 27 08 ff ff ff ff ff ff ff ff ff 01 12 1a   )"'.............
  0010  0a 13 74 79 70 65 2e 61 6e 6b 61 6d 61 2e 63 6f   ..type.ankama.co
  0020  6d 2f 6b 61 67 12 03 10 fe 07                     m/kag.....
```

Structure: `29` = varint frame length (41). `22 27` = field 4, length 39 →
a `Frame.Request`. `08 ff ff ff ff ff ff ff ff ff 01` = field 1 varint, all
bits set.

**That correlation id is `-1`, not 1.8e19.** It is a sign-extended `int64`.
This is exactly the class of bug fixed by the signed-varint handling in
`src/dump.rs`; unsigned rendering made these look like garbage.

A variant carries an extra leading field:

```
  0000  2b 22 29 08 ff ff ff ff ff ff ff ff ff 01 12 1c   +").............
  0010  0a 13 74 79 70 65 2e 61 6e 6b 61 6d 61 2e 63 6f   ..type.ankama.co
  0020  6d 2f 6b 61 67 12 05 08 01 10 e1 3f               m/kag......?
```

`12 05 08 01 10 e1 3f` → inner message `{1: 1, 2: 8161}`. The `8161` recurs as
`kdh`'s first attribute below, so `kag` looks like a request naming the same
entity the `kdh` reply describes.

## Server → client: `kdh` (price list)

Short form — just an id and a count:

```
[203.0.113.5:5555 -> 192.0.2.10:49788] seq=3342554860 len=33
  0000  20 0a 1e 0a 1c 0a 13 74 79 70 65 2e 61 6e 6b 61    ......type.anka
  0010  6d 61 2e 63 6f 6d 2f 6b 64 68 12 05 18 fe 07 20   ma.com/kdh..... 
  0020  68                                                h
```

Full form — this is the `dump.rs` test fixture:

```
[203.0.113.5:5555 -> 192.0.2.10:49788] seq=3342554893 len=54
  0000  35 0a 33 0a 31 0a 13 74 79 70 65 2e 61 6e 6b 61   5.3.1..type.anka
  0010  6d 61 2e 63 6f 6d 2f 6b 64 68 12 1a 0a 13 08 e1   ma.com/kdh......
  0020  3f 10 68 22 08 8a 03 c5 0f a4 c3 01 00 28 ab 9d   ?.h".........(..
  0030  01 18 e1 3f 20 68                                 ...? h
```

Decodes to:

```
vars  = [8161, 104, 20139, 8161, 104]
packs = [[394, 1989, 24996, 0]]
```

The packed array is the batch price ladder: quantity 1 / 10 / 100 / 1000.

### The `61 A4` confusion — resolved

`notes3.md` recorded a comparison against values shown in the game client:

```
08 8a != 01 8A
03 c5 != 07 C5
0f a4 != 61 A4
```

This is not a discrepancy. The left column is **raw varint bytes**, the right
is the **decoded value in hex**. `8a 03` is little-endian base-128:
`0x0a | (0x03 << 7)` = 394. Likewise `a4 c3 01` → 24996 = `0x61A4`, which is
the `61 A4` the game displayed. The decoder was already correct here; the
bytes just don't look like the number until you decode them.

## Server → client: `jqj`

```
[203.0.113.5:5555 -> 192.0.2.10:49788] seq=3342554947 len=47
  0000  2e 0a 2c 0a 2a 0a 13 74 79 70 65 2e 61 6e 6b 61   ..,.*..type.anka
  0010  6d 61 2e 63 6f 6d 2f 6a 71 6a 12 13 10 db e3 fe   ma.com/jqj......
  0020  ff ff ff ff ff ff 01 1a 04 ea 03 dd 03 20 03      ............. .
```

Field 2 = `db e3 fe ff ff ff ff ff ff 01` → another sign-extended negative.
Field 3 = `ea 03 dd 03` → a two-element packed array `[490, 477]`.

## Polling pattern

`notes2.md` captured the steady-state loop: the client sends `kag` with an
entity id, the server answers `kdh` with that id plus a count, repeatedly.
Useful as a keepalive/heartbeat signature when identifying flows.

```
-> kag  {2: 8161}
<- kdh  {3: 8161, 4: 104}
-> kag  {2: 8161}
```

## 2026-08-04: the client update that rotated everything

Recorded because the previous entries in this file are all keyed to a build
whose keys are gone, and because the *shape* of the rotation is the reusable
part. Bytes below are real, from `packets`.

### How much moved

141 distinct keys in the 2026-08-03 session, 91 in the first session after the
update, **19 shared**. The strongest single reading is the connection
handshake, which is identical in kind every session:

```
AUG 3   ksv jri jri jri jri knh kmw jri jrj jri jrj iwa jri iwa jrj iwa jri jpp
AUG 4   lqu hoy kqu mgq mgt hpd kqz krv mgz kqp kqp kvi jtg kvw kub jbf ipc kva
```

Nothing in common. The new build also emits `m*` and `h*` prefixes, which the
old one never did.

### A survivor that changed meaning

`iun` was `inventory_add`. It is still on the wire and now means something else:

```
Aug 3  iun  24 B  0a16083f2212089c81b3a1011807209d3a2a05400148f201   an inventory slot
Aug 4  iun   6 B  08ff02189c35                                       {1: 383, 3: 6812}
```

Field 3 is constant across samples and field 1 tracks what was just picked up or
crushed — current and maximum pods. Left mapped, it would have written rows.

### Re-identification, one action each

Every mapping below came from one deliberate in-game action against the archive.

```
kdk  client  browse a category          kda  server  item ids in that category
keh  client  ask prices for an item     kbt  server  the ladder      = price_list
kbm  client  buy {listing, price, qty}  kgv  server  purchase confirmed
kcr  client  put into breaker           kfb  server  item detail     = item_detail
kbj  client  crush it                   kfp  server  the yield       = crush_result
ktm  client  chat send                  kti  server  chat broadcast  = chat_message
                                        ivx  server  the bag         = inventory
                                        iua  server  a stack arrived = inventory_add
                                        ivj  server  a stack resized = inventory_quantity
                                        ium  server  a uid left      = inventory_remove
```

`kti` was free: the body carries `2026-08-04T10:42:38+02:00`, the author, and
the typed text in plain ASCII. `ivx` used the same test as the previous build —
the purchased Palmano's uid 2447309 appears in exactly one bag listing and in no
other container listing.

### The field numbers moved too

This is the part that would have been missed. Repointing the keys alone makes
every message name and dump correctly while storing nothing.

`price_list`, measured on both builds:

```
                 2026-07-10        2026-08-04
outer category   f1 varint         f1 varint      same
outer item id    f3 varint         f2 varint
outer offer      f2 Len            f3 Len
offer item id    f1 varint         f5 varint
offer stat line  f4 Len            f4 Len         same
offer ladder     f5 Len packed     f6 Len packed
offer listing    f7 varint         f1 varint
```

`crush_slot_put` is the only message whose numbers did not move at all.

**No shape changed anywhere.** Same nesting depth, same wire types, same packed
ladder, same repeated stat lines, same backwards value-then-effect-id order.
Both are data now, in `sniffer/schema.json`: the shape *and* the numbers. What
stayed in Rust is meaning — an empty ladder is not a price message, a missing
quantity is one copy, a negative delta is a removal.

### Reading a moved field without guessing

Use an item whose template you already have. Palmano is 8872, and DofusDB gives
174 Initiative 101-150, 119 Agilité 16-20, 182 Invocation 1-1. Its `kfb`:

```
0a22 083f 2a1e
  08 a845                 item 8872
  1205 20 70 58 ae01      {4: 112, 11: 174}   Initiative 112, in 101-150
  1204 20 10 58 77        {4: 16,  11: 119}   Agilité 16,    in 16-20
  1205 20 01 58 b601      {4: 1,   11: 182}   Invocation 1,  in 1-1
  1801                    quantity 1
  20 cdaf9501             uid 2447309
```

Three lines, three ranges, one arrangement that fits: value at 4, effect id at
11. Then the crush of that same uid returns Ini x20, Invo x2, Age x28 — the same
three effects, which confirms the read from the other end.
