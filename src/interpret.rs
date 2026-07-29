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
        "kdh" => Some(kdh(body, reg)),
        // TODO: add interpreters as messages are identified, e.g.
        // "abc" => Some(movement(body, reg)),
        _ => None,
    }
}

/// Whether a message key has an interpreter. Keep in sync with `interpret`.
pub fn is_known_key(key: &str) -> bool {
    matches!(key, "kdh")
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
                    LenKind::PackedVarint => c.packs.push(packed(b)),
                    LenKind::Message(tok) => {
                        collect(b, reg.resolve(leaf(&tok)), reg, c);
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

/// a, b, ..., z, a1, b1, ...
fn attr_name(i: usize) -> String {
    let letter = (b'a' + (i % 26) as u8) as char;
    if i < 26 {
        letter.to_string()
    } else {
        format!("{letter}{}", i / 26)
    }
}
