//! Message -> understandable data.
//!
//! Per-message-type interpreters that turn a decoded protobuf body into named,
//! human-meaningful attributes.
//!
//! Interpreters key off the *semantic* message name (see `crate::messages`),
//! never the obfuscated wire key, and parse the body structurally with
//! `pb::Reader` rather than through the schema registry — the registry
//! describes an older build and cannot be trusted for field types.

use crate::messages;
use crate::pb::{Reader, WireType};
use crate::registry::{leaf, Registry};

/// Return a one-line understandable rendering for a known message, or None.
///
/// Dispatches on the *semantic* name, never the wire key — the keys rotate per
/// client build, so `crate::messages` owns that translation. To support a new
/// message: add its key to `messages::DEFAULTS`, then add an arm here.
pub fn interpret(key: &str, body: &[u8]) -> Option<String> {
    match messages::keymap().name(key)? {
        "price_list" => price_list(body).map(|p| p.to_string()),
        "crush_result" => crush_result(body).map(|c| c.to_string()),
        // Shown in --all output but deliberately not stored: the focus does
        // not change the yield, so it says nothing the crush row needs.
        "crush_slot_put" => crush_slot_change(body).map(|(delta, uid)| {
            if delta > 0 {
                format!("placed in breaker {{ uid={uid} x{delta} }}")
            } else {
                format!("taken out of breaker {{ uid={uid} x{} }}", -delta)
            }
        }),
        "crush_request" => Some(match crush_focus(body) {
            Some(effect) => format!("crush requested {{ focus effect {effect} }}"),
            None => "crush requested { no focus }".to_string(),
        }),
        _ => None,
    }
}

/// Whether we can interpret this wire key. Keep in sync with `interpret`.
pub fn is_known_key(key: &str) -> bool {
    matches!(
        messages::keymap().name(key),
        Some("price_list")
            | Some("crush_result")
            | Some("crush_request")
            | Some("crush_slot_put")
    )
}

// ---- crush_result: breaking an item into runes (brisage) -------------------
//
// Identified by known-plaintext search across three real crushes, matching the
// rune counts and percentages read off the screen.
//
//   field 1  message
//       field 1  message   REPEATED, one per rune type
//           field 1  varint   rune item id
//           field 2  varint   how many were obtained
//       field 2  i32      float32 yield, 0.0-1.0  (0.76943 displayed as 77%)
//       field 3  varint   the crushed item's INSTANCE uid, not its type id
//       field 4  i32      float32, identical to field 2 in all observed
//                         samples; purpose unknown, so not stored
//
// The item *type* is not in this message. It arrives earlier as `item_detail`
// keyed by the same uid, which main.rs caches to fill it in.
//
// Focus (focalisation) is NOT here. It travels in the `crush_request` the client
// sends immediately before, as field 1 — see that section below. An earlier note
// claiming it was not sent per-crush was wrong: the requests do differ, but only
// in a field that is absent entirely when no focus is set, which is easy to miss.

#[derive(Debug, Clone, PartialEq)]
pub struct CrushResult {
    /// Instance uid of the crushed item. Join to `item_detail` for the type id.
    pub item_uid: u64,
    /// Yield as a fraction, 0.0-1.0. The client shows it as a percentage.
    pub yield_fraction: f32,
    /// (rune item id, quantity), one entry per rune type.
    pub runes: Vec<(u64, u64)>,
}

impl std::fmt::Display for CrushResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let runes: Vec<String> = self
            .runes
            .iter()
            .map(|(id, n)| format!("{id}x{n}"))
            .collect();
        write!(
            f,
            "crush {{ uid={} yield={:.1}% runes[{}] }}",
            self.item_uid,
            self.yield_fraction * 100.0,
            runes.join(" ")
        )
    }
}

fn read_f32(r: &mut Reader) -> Option<f32> {
    let b = r.read_bytes(4)?;
    Some(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Parse a crush (brisage) result straight off the wire.
pub fn crush_result(body: &[u8]) -> Option<CrushResult> {
    let mut out = CrushResult { item_uid: 0, yield_fraction: 0.0, runes: Vec::new() };
    let mut r = Reader::new(body);
    while !r.eof() {
        let (field, wt) = r.tag()?;
        match (field, wt) {
            (1, WireType::Len) => {
                let inner = r.len_field()?;
                let mut ir = Reader::new(inner);
                while !ir.eof() {
                    let (f, w) = ir.tag()?;
                    match (f, w) {
                        // repeated: one entry per rune type
                        (1, WireType::Len) => {
                            let e = ir.len_field()?;
                            let mut er = Reader::new(e);
                            let (mut rune, mut count) = (0u64, 0u64);
                            while !er.eof() {
                                let (ef, ew) = er.tag()?;
                                match (ef, ew) {
                                    (1, WireType::Varint) => rune = er.varint()?,
                                    (2, WireType::Varint) => count = er.varint()?,
                                    (_, ew) => {
                                        if !er.skip(ew) {
                                            return None;
                                        }
                                    }
                                }
                            }
                            if rune != 0 {
                                out.runes.push((rune, count));
                            }
                        }
                        (2, WireType::I32) => out.yield_fraction = read_f32(&mut ir)?,
                        (3, WireType::Varint) => out.item_uid = ir.varint()?,
                        (_, w) => {
                            if !ir.skip(w) {
                                return None;
                            }
                        }
                    }
                }
            }
            (_, wt) => {
                if !r.skip(wt) {
                    return None;
                }
            }
        }
    }
    // a crush with no runes and no item is not one
    if out.item_uid == 0 || out.runes.is_empty() {
        return None;
    }
    Some(out)
}

// ---- crush_slot_put: item placed into the breaker --------------------------
//
// Sent when an item is dropped into the breaker's slot, and answered by an
// `item_detail` for the same uid. Confirmed by a placement with no crush after
// it: the item sat in the slot while the focus was changed and was never broken.
//
//   field 1  varint   SIGNED quantity delta: +1 adds one, -1 takes one back out
//   field 2  varint   instance uid of the item placed
//
// Field 1 is not always 1. A capture where an item was placed and then pulled
// back out carries `1=-1` (0xFFFF_FFFF_FFFF_FFFF as a two's-complement varint)
// for the same uid. Both directions are answered by an identical `item_detail`,
// so the sign is the only thing distinguishing a placement from a removal — read
// it, or the breaker's contents are tracked wrong and a removed item still looks
// like it is about to be crushed.

/// The instance uid of an item just put into the breaker, and `None` for a
/// removal — the caller only cares about what is going *in*.
pub fn crush_slot_put(body: &[u8]) -> Option<u64> {
    let (delta, uid) = crush_slot_change(body)?;
    (delta > 0).then_some(uid)
}

/// The raw `(quantity delta, uid)`, negative delta meaning the item left the
/// slot. Split out so the sign is testable independently of the filtering.
pub fn crush_slot_change(body: &[u8]) -> Option<(i64, u64)> {
    let mut r = Reader::new(body);
    let (mut delta, mut uid) = (None, None);
    while !r.eof() {
        let (field, wt) = r.tag()?;
        match (field, wt) {
            (1, WireType::Varint) => delta = Some(r.varint()? as i64),
            (2, WireType::Varint) => uid = Some(r.varint()?),
            (_, wt) => {
                if !r.skip(wt) {
                    return None;
                }
            }
        }
    }
    // A missing field 1 is protobuf's default of 0, but every sample carries it
    // explicitly; treat its absence as "one, going in" rather than dropping the
    // message, since the uid is the part that matters.
    Some((delta.unwrap_or(1), uid?))
}

// ---- crush_request: the client's "crush it" command ------------------------
//
// Sent immediately before every crush result. Field 1 carries the focus and is
// ABSENT when no focus is set — established across three crushes:
//
//   1=125 4=1 5=1   Baton d'Oubli, focus Vi
//         4=1 5=1   Arc Anum,      no focus      <- field 1 missing
//   1=125 4=1 5=2   Anneau Bsene,  focus Vi
//
// 125 is the rune's *effect id*, not its item id: DofusDB gives Rune Vi (1523)
// effectId 125, Rune Ine (1522) 126, Rune Age (1524) 119. One effect id covers
// several runes — 125 is Rune Vi, Rune Pa Vi and Rune Ra Vi alike.
//
// This is decoded for --all output but NOT stored. The focus does not affect
// the yield: the same item crushed with any focus, or none, returns the same
// percentage. Only the yield varies per crush, so only the yield is recorded.
//
// Fields 4 and 5 vary (1/1, 1/1, 1/2) and are not understood, so not stored.

/// The focus effect id from a crush request, or None when no focus was set.
pub fn crush_focus(body: &[u8]) -> Option<u64> {
    let mut r = Reader::new(body);
    let mut focus = None;
    while !r.eof() {
        let (field, wt) = r.tag()?;
        match (field, wt) {
            (1, WireType::Varint) => focus = Some(r.varint()?),
            (_, wt) => {
                if !r.skip(wt) {
                    return None;
                }
            }
        }
    }
    focus
}

// ---- item_detail: instance uid -> item type id -----------------------------
//
// Sent just before a crush result, describing the item about to be destroyed.
// Only the uid -> type id mapping is extracted; the rest is the item's stat
// list, which nothing consumes yet.
//
//   field 2  message
//       field 4  message
//           field 1  varint   instance uid
//           field 4  varint   item type id  (joins to DofusDB, and to prices)

/// Extract `(instance uid, item type id)` if this message carries both.
pub fn item_detail(body: &[u8]) -> Option<(u64, u64)> {
    let mut r = Reader::new(body);
    while !r.eof() {
        let (field, wt) = r.tag()?;
        if field == 2 && wt == WireType::Len {
            let lvl2 = r.len_field()?;
            let mut r2 = Reader::new(lvl2);
            while !r2.eof() {
                let (f2, w2) = r2.tag()?;
                if f2 == 4 && w2 == WireType::Len {
                    let lvl3 = r2.len_field()?;
                    let mut r3 = Reader::new(lvl3);
                    let (mut uid, mut item) = (0u64, 0u64);
                    while !r3.eof() {
                        let (f3, w3) = r3.tag()?;
                        match (f3, w3) {
                            (1, WireType::Varint) => uid = r3.varint()?,
                            (4, WireType::Varint) => item = r3.varint()?,
                            (_, w3) => {
                                if !r3.skip(w3) {
                                    break;
                                }
                            }
                        }
                    }
                    if uid != 0 && item != 0 {
                        return Some((uid, item));
                    }
                } else if !r2.skip(w2) {
                    return None;
                }
            }
        } else if !r.skip(wt) {
            return None;
        }
    }
    None
}

// ---- price_list: marketplace price ladder ---------------------------------
//
// Identified by known-plaintext search: the prices shown in the HDV for one
// item turned up verbatim in this message (tools/findvalue.py). Parsed
// structurally rather than through the schema registry, which is keyed to an
// older build and cannot be trusted for this key.
//
//   field 1  varint            category (repeats as inner field 6)
//   field 2  message
//       field 1  varint        item id
//       field 5  packed        price ladder: x1, x10, x100, x1000
//       field 7  varint        listing id
//   field 3  varint            item id (repeats inner field 1)
//
// A ladder entry of 0 means that batch size is not on sale.

#[derive(Debug, Clone, PartialEq)]
pub struct PriceList {
    pub category: u64,
    pub item_id: u64,
    pub ladder: Vec<u64>,
    pub listing_id: u64,
}

impl std::fmt::Display for PriceList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let batches: Vec<String> = self
            .ladder
            .iter()
            .enumerate()
            .map(|(i, v)| format!("{}:{}", 10u64.pow(i as u32), v))
            .collect();
        write!(
            f,
            "prices {{ item={} category={} listing={} {} }}",
            self.item_id,
            self.category,
            self.listing_id,
            batches.join(" ")
        )
    }
}

/// Parse a price-list message straight off the wire.
pub fn price_list(body: &[u8]) -> Option<PriceList> {
    let mut out = PriceList { category: 0, item_id: 0, ladder: Vec::new(), listing_id: 0 };
    let mut r = Reader::new(body);
    while !r.eof() {
        let (field, wt) = r.tag()?;
        match (field, wt) {
            (1, WireType::Varint) => out.category = r.varint()?,
            (3, WireType::Varint) => out.item_id = r.varint()?,
            (2, WireType::Len) => {
                let inner = r.len_field()?;
                let mut ir = Reader::new(inner);
                while !ir.eof() {
                    let (f, w) = ir.tag()?;
                    match (f, w) {
                        // the outer copy is authoritative when both are present
                        (1, WireType::Varint) => {
                            let v = ir.varint()?;
                            if out.item_id == 0 {
                                out.item_id = v;
                            }
                        }
                        (5, WireType::Len) => out.ladder = packed(ir.len_field()?),
                        (7, WireType::Varint) => out.listing_id = ir.varint()?,
                        (_, w) => {
                            if !ir.skip(w) {
                                return None;
                            }
                        }
                    }
                }
            }
            (_, wt) => {
                if !r.skip(wt) {
                    return None;
                }
            }
        }
    }
    // a price message without a ladder is not one
    if out.ladder.is_empty() {
        return None;
    }
    Some(out)
}

/// Schema-guided decoded values for a message key: every varint (in traversal
/// order) and every packed repeated-scalar array. Handlers receive this.
pub fn values(key: &str, body: &[u8], reg: &Registry) -> Collected {
    let mut c = Collected::default();
    collect(body, reg.resolve(key), reg, &mut c);
    c
}

// ---- generic schema-guided collection -------------------------------------

#[derive(Default, Debug, Clone)]
pub struct Collected {
    pub vars: Vec<u64>,
    pub packs: Vec<Vec<u64>>,
}

enum LenKind {
    PackedVarint,
    Message(String),
    /// Declaration contradicts the wire — decide from the bytes instead.
    Heuristic,
    Skip,
}

fn classify_len(csharp: Option<&str>) -> LenKind {
    let t = match csharp {
        Some(t) => t.trim(),
        None => return LenKind::Skip,
    };
    if let Some(inner) = t.strip_prefix("RepeatedField<").and_then(|s| s.strip_suffix('>')) {
        return if is_scalar(inner) {
            LenKind::PackedVarint
        } else if is_len_scalar(inner) {
            LenKind::Skip // repeated string/bytes
        } else {
            LenKind::Message(inner.to_string())
        };
    }
    if t.starts_with("MapField<") || is_len_scalar(t) {
        return LenKind::Skip;
    }
    // A bare scalar can't be length-delimited: the schema is mis-joined here,
    // so ignore it rather than recurse into what is probably a string.
    if is_scalar(t) {
        return LenKind::Heuristic;
    }
    LenKind::Message(t.to_string())
}

fn is_scalar(t: &str) -> bool {
    matches!(
        t,
        "int" | "uint" | "long" | "ulong" | "bool" | "sbyte" | "byte" | "short" | "ushort" | "char"
    )
}

fn is_len_scalar(t: &str) -> bool {
    matches!(t, "string" | "ByteString")
}

fn collect(buf: &[u8], schema: Option<&crate::registry::Msg>, reg: &Registry, c: &mut Collected) {
    let mut r = Reader::new(buf);
    while !r.eof() {
        let (field, wt) = match r.tag() {
            Some(t) => t,
            None => return,
        };
        let csharp = schema
            .and_then(|s| s.fields.iter().find(|f| f.num == field))
            .map(|f| f.csharp.as_str());
        match wt {
            WireType::Varint => {
                c.vars.push(r.varint().unwrap_or(0));
            }
            WireType::Len => {
                let b = r.len_field().unwrap_or(&[]);
                match classify_len(csharp) {
                    // printable bytes under a packed declaration = mis-joined
                    // string field; feeding it to handlers as numbers is worse
                    // than dropping it
                    LenKind::PackedVarint if crate::pb::looks_like_text(b) => {}
                    LenKind::PackedVarint => c.packs.push(packed(b)),
                    LenKind::Message(tok) => {
                        collect(b, reg.resolve(leaf(&tok)), reg, c);
                    }
                    LenKind::Heuristic => {
                        if !b.is_empty() && crate::pb::looks_like_message(b) {
                            collect(b, None, reg, c);
                        }
                    }
                    LenKind::Skip => {}
                }
            }
            _ => {
                if !r.skip(wt) {
                    return;
                }
            }
        }
    }
}

fn packed(b: &[u8]) -> Vec<u64> {
    let mut r = Reader::new(b);
    let mut out = Vec::new();
    while !r.eof() {
        match r.varint() {
            Some(v) => out.push(v),
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real captured price-list message, identified by known-plaintext search: the client
    // showed Carapace Verte at 1=75, 10=326, 100=6660, 1000=99999 and those
    // exact values appear here. Keep byte-exact.
    const PRICE_LIST: &[u8] = &[
        0x08, 0x6b, 0x12, 0x12, 0x08, 0xb1, 0x14, 0x2a, 0x08, 0x4b, 0xc6, 0x02, 0x84, 0x34,
        0x9f, 0x8d, 0x06, 0x30, 0x6b, 0x38, 0xc2, 0x4e, 0x18, 0xb1, 0x14,
    ];


    // Real captured crushes. The client showed, for the Arc Anum: 32%, and
    // 2+1+10+2+11+23+2+20 runes across 8 types. Keep byte-exact.
    const CRUSH_ARC: &[u8] = &[
        0x0a, 0x47, 0x0a, 0x05, 0x08, 0xa1, 0x3a, 0x10, 0x02, 0x0a, 0x05, 0x08,
        0xa4, 0x3a, 0x10, 0x01, 0x0a, 0x05, 0x08, 0xf3, 0x0b, 0x10, 0x0a, 0x0a,
        0x05, 0x08, 0x91, 0x5b, 0x10, 0x02, 0x0a, 0x05, 0x08, 0x98, 0x3a, 0x10,
        0x0b, 0x0a, 0x05, 0x08, 0xf2, 0x0b, 0x10, 0x17, 0x0a, 0x05, 0x08, 0x8b,
        0x5b, 0x10, 0x02, 0x0a, 0x05, 0x08, 0xf4, 0x0b, 0x10, 0x14, 0x15, 0x00,
        0xc9, 0xa4, 0x3e, 0x18, 0xd8, 0xe0, 0xa2, 0x3c, 0x25, 0x1a, 0xc9, 0xa4,
        0x3e,
    ];

    // Anneau Bsene: 48%, 32 Rune Vi (id 1523), crushed with focus set.
    const CRUSH_RING: &[u8] = &[
        0x0a, 0x16, 0x0a, 0x05, 0x08, 0xf3, 0x0b, 0x10, 0x20, 0x15, 0x2a, 0xfd,
        0xf4, 0x3e, 0x18, 0x82, 0xef, 0xa3, 0x3c, 0x25, 0x45, 0xfd, 0xf4, 0x3e,
    ];

    // item_detail for the ring, mapping its instance uid to type id 7123.
    const ITEM_DETAIL_RING: &[u8] = &[
        0x12, 0x36, 0x08, 0x3f, 0x22, 0x32, 0x08, 0x82, 0xef, 0xa3, 0x3c, 0x18,
        0x01, 0x20, 0xd3, 0x37, 0x2a, 0x04, 0x40, 0x1c, 0x48, 0x7d, 0x2a, 0x04,
        0x40, 0x02, 0x48, 0x70, 0x2a, 0x05, 0x40, 0x02, 0x48, 0xb2, 0x01, 0x2a,
        0x05, 0x40, 0x02, 0x48, 0xd5, 0x01, 0x2a, 0x05, 0x40, 0x02, 0x48, 0xd3,
        0x01, 0x2a, 0x05, 0x40, 0x01, 0x48, 0xb6, 0x01,
    ];

    // Real crush requests. Field 1 is the focus effect id and is absent when
    // no focus is set — the whole difference between these three.
    const REQ_FOCUS_VI: &[u8] = &[0x08, 0x7d, 0x20, 0x01, 0x28, 0x01]; // Baton d'Oubli
    const REQ_NO_FOCUS: &[u8] = &[0x20, 0x01, 0x28, 0x01]; // Arc Anum
    const REQ_FOCUS_VI2: &[u8] = &[0x08, 0x7d, 0x20, 0x01, 0x28, 0x02]; // Anneau Bsene

    // real placement: the item that was loaded into the breaker and never broken
    const SLOT_PUT: &[u8] = &[0x08, 0x01, 0x10, 0x95, 0xa9, 0xc3, 0x3c];

    // real removal: a Kwape de Glace put into the breaker and then pulled back
    // out before the crush. Field 1 is -1 as a two's-complement varint.
    const SLOT_REMOVE: &[u8] = &[
        0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x10, 0xfe, 0xca, 0xfb,
        0x3e,
    ];
    // the same uid going the other way, captured moments earlier
    const SLOT_ADD: &[u8] = &[0x08, 0x01, 0x10, 0xfe, 0xca, 0xfb, 0x3e];

    #[test]
    fn slot_put_reads_the_uid() {
        assert_eq!(crush_slot_put(SLOT_PUT), Some(126932117));
        // a crush request is not a placement
        assert_eq!(crush_slot_put(REQ_NO_FOCUS), None);
    }

    #[test]
    fn slot_removal_is_not_a_placement() {
        // same uid, opposite directions — only the sign of field 1 separates them
        assert_eq!(crush_slot_change(SLOT_ADD), Some((1, 132048254)));
        assert_eq!(crush_slot_change(SLOT_REMOVE), Some((-1, 132048254)));
        assert_eq!(crush_slot_put(SLOT_ADD), Some(132048254));
        assert_eq!(crush_slot_put(SLOT_REMOVE), None);
    }

    #[test]
    fn crush_focus_is_read_when_set() {
        // 125 is Rune Vi's effectId in DofusDB, not its item id (1523)
        assert_eq!(crush_focus(REQ_FOCUS_VI), Some(125));
        assert_eq!(crush_focus(REQ_FOCUS_VI2), Some(125));
    }

    #[test]
    fn crush_focus_is_none_when_unset() {
        assert_eq!(crush_focus(REQ_NO_FOCUS), None, "field 1 absent = no focus");
    }

    #[test]
    fn crush_decodes_many_rune_types() {
        let c = crush_result(CRUSH_ARC).expect("parses");
        assert_eq!(c.runes.len(), 8, "one entry per rune type");
        let total: u64 = c.runes.iter().map(|(_, n)| n).sum();
        assert_eq!(total, 71, "2+1+10+2+11+23+2+20 as shown in game");
        // Rune Vi was 10 of the 71
        assert!(c.runes.contains(&(1523, 10)), "{:?}", c.runes);
        assert!((c.yield_fraction - 0.32185).abs() < 1e-4, "32%: {}", c.yield_fraction);
        assert_eq!(c.item_uid, 126398552);
    }

    #[test]
    fn crush_decodes_single_rune_type() {
        let c = crush_result(CRUSH_RING).expect("parses");
        assert_eq!(c.runes, vec![(1523, 32)], "32 Rune Vi");
        assert!((c.yield_fraction - 0.47849).abs() < 1e-4, "48%: {}", c.yield_fraction);
        assert_eq!(c.item_uid, 126416770);
    }

    #[test]
    fn item_detail_maps_uid_to_type() {
        // the same uid the ring crush reports, resolving to Anneau Bsene
        assert_eq!(item_detail(ITEM_DETAIL_RING), Some((126416770, 7123)));
    }

    #[test]
    fn crush_rejects_unrelated_messages() {
        assert!(crush_result(PRICE_LIST).is_none(), "a price list is not a crush");
        assert!(item_detail(PRICE_LIST).is_none());
    }

    #[test]
    fn price_list_decodes_the_ladder() {
        let p = price_list(PRICE_LIST).expect("parses");
        assert_eq!(p.ladder, vec![75, 326, 6660, 99999], "prices shown in game");
        assert_eq!(p.item_id, 2609);
        assert_eq!(p.category, 107);
        assert_eq!(p.listing_id, 10050);
        assert!(is_known_key(messages::keymap().key("price_list").unwrap()));
    }

    #[test]
    fn price_list_renders_batches() {
        let s = price_list(PRICE_LIST).unwrap().to_string();
        assert!(s.contains("1:75"), "{s}");
        assert!(s.contains("1000:99999"), "{s}");
        assert!(s.contains("item=2609"), "{s}");
    }

    #[test]
    fn price_list_rejects_messages_without_a_ladder() {
        // a short `kea` ack carrying only ids — real capture, no prices in it
        assert!(price_list(&[0x08, 0x77, 0x18, 0x8a, 0x0d]).is_none());
    }
}

