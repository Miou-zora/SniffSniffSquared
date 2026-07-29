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
