//! Message -> understandable data.
//!
//! Per-message-type interpreters that turn a decoded protobuf body into named,
//! human-meaningful attributes. Add a new `match` arm as you figure each
//! message out. Everything is empty for now except `kdh`.

use crate::pb::{Reader, WireType};
use crate::registry::{leaf, Registry};

/// Return a one-line understandable rendering for a known message key, or None.
pub fn interpret(key: &str, body: &[u8], reg: &Registry) -> Option<String> {
    match key {
        "kea" => kea(body).map(|p| p.to_string()),
        // `kdh` was the price list on the 2026-07-10 build. That key no longer
        // exists on the wire — the obfuscated keys rotate per build — so this
        // arm never fires against a current client. Kept because the decoder
        // tests pin real captured `kdh` bytes.
        "kdh" => Some(kdh(body, reg)),
        _ => None,
    }
}

/// Whether a message key has an interpreter. Keep in sync with `interpret`.
pub fn is_known_key(key: &str) -> bool {
    matches!(key, "kea" | "kdh")
}

// ---- kea: marketplace price list ------------------------------------------
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
pub struct Kea {
    pub category: u64,
    pub item_id: u64,
    pub ladder: Vec<u64>,
    pub listing_id: u64,
}

impl std::fmt::Display for Kea {
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

/// Parse a `kea` price-list message straight off the wire.
pub fn kea(body: &[u8]) -> Option<Kea> {
    let mut out = Kea { category: 0, item_id: 0, ladder: Vec::new(), listing_id: 0 };
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

// ---- kdh ------------------------------------------------------------------
// packed repeated int64 -> batches keyed 1, 10, 100, 1000, ...
// every other varint    -> attributes a, b, c, ...

/// Schema-guided decoded values for a message key: every varint (in traversal
/// order) and every packed repeated-scalar array. Handlers receive this.
pub fn values(key: &str, body: &[u8], reg: &Registry) -> Collected {
    let mut c = Collected::default();
    collect(body, reg.resolve(key), reg, &mut c);
    c
}

fn kdh(body: &[u8], reg: &Registry) -> String {
    let c = values("kdh", body, reg);

    let mut parts = Vec::new();
    for (i, v) in c.vars.iter().enumerate() {
        parts.push(format!("{}={}", attr_name(i), v));
    }
    for (pi, pack) in c.packs.iter().enumerate() {
        let batches: Vec<String> = pack
            .iter()
            .enumerate()
            .map(|(i, v)| format!("{}:{}", 10u64.pow(i as u32), v))
            .collect();
        let label = if c.packs.len() == 1 {
            "batches".to_string()
        } else {
            format!("batches{}", pi + 1)
        };
        parts.push(format!("{label}{{{}}}", batches.join(" ")));
    }
    format!("kdh {{ {} }}", parts.join(" "))
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

    // Real captured `kea`, identified by known-plaintext search: the client
    // showed Carapace Verte at 1=75, 10=326, 100=6660, 1000=99999 and those
    // exact values appear here. Keep byte-exact.
    const KEA: &[u8] = &[
        0x08, 0x6b, 0x12, 0x12, 0x08, 0xb1, 0x14, 0x2a, 0x08, 0x4b, 0xc6, 0x02, 0x84, 0x34,
        0x9f, 0x8d, 0x06, 0x30, 0x6b, 0x38, 0xc2, 0x4e, 0x18, 0xb1, 0x14,
    ];

    #[test]
    fn kea_decodes_the_price_ladder() {
        let p = kea(KEA).expect("parses");
        assert_eq!(p.ladder, vec![75, 326, 6660, 99999], "prices shown in game");
        assert_eq!(p.item_id, 2609);
        assert_eq!(p.category, 107);
        assert_eq!(p.listing_id, 10050);
        assert!(is_known_key("kea"));
    }

    #[test]
    fn kea_renders_batches() {
        let s = kea(KEA).unwrap().to_string();
        assert!(s.contains("1:75"), "{s}");
        assert!(s.contains("1000:99999"), "{s}");
        assert!(s.contains("item=2609"), "{s}");
    }

    #[test]
    fn kea_rejects_messages_without_a_ladder() {
        // a short `kea` ack carrying only ids — real capture, no prices in it
        assert!(kea(&[0x08, 0x77, 0x18, 0x8a, 0x0d]).is_none());
    }
}

/// a, b, ..., z, a1, b1, ...
fn attr_name(i: usize) -> String {
    let letter = (b'a' + (i % 26) as u8) as char;
    if i < 26 {
        letter.to_string()
    } else {
        format!("{letter}{}", i / 26)
    }
}
