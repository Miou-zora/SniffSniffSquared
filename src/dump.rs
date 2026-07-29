//! Message body pretty-printer.
//!
//! - Detects and unwraps `google.protobuf.Any` (`type.ankama.com/<key>`),
//!   resolving `<key>` to a schema and decoding the inner bytes.
//! - When a schema is known, decodes fields by their declared type (packed
//!   repeateds, nested messages, strings) instead of guessing.
//! - Falls back to schema-less heuristics for unknown fields/messages.

use crate::pb::{looks_like_message, Reader, WireType};
use crate::registry::{leaf, Msg, Registry};

pub fn dump(buf: &[u8], reg: Option<&Registry>, schema: Option<&Msg>, indent: usize) -> String {
    let pad = "  ".repeat(indent);

    // google.protobuf.Any?  field1 = "type.../<key>", field2 = value bytes
    if let Some((url, value)) = any_unwrap(buf) {
        let key = url.rsplit('/').next().unwrap_or(&url);
        let inner_schema = reg.and_then(|r| r.resolve(key));
        let named = inner_schema
            .map(|m| format!(" [{}]", m.real.clone().unwrap_or_else(|| m.obf.clone())))
            .unwrap_or_default();
        let mut out = format!("{pad}Any <{url}>{named}\n");
        if let Some(r) = reg {
            if let Some(understood) = crate::interpret::interpret(key, value, r) {
                out.push_str(&format!("{pad}  => {understood}\n"));
            }
        }
        out.push_str(&dump(value, reg, inner_schema, indent + 1));
        return out;
    }

    let mut out = String::new();
    let mut r = Reader::new(buf);
    while !r.eof() {
        let (field, wt) = match r.tag() {
            Some(t) => t,
            None => {
                out.push_str(&format!("{pad}<malformed tag @ {}>\n", r.pos));
                break;
            }
        };
        let decl = schema.and_then(|s| s.fields.iter().find(|f| f.num == field));
        out.push_str(&render_field(&mut r, field, wt, decl.map(|f| f.csharp.as_str()), reg, indent));
    }
    out
}

fn render_field(
    r: &mut Reader,
    field: u32,
    wt: WireType,
    csharp: Option<&str>,
    reg: Option<&Registry>,
    indent: usize,
) -> String {
    let pad = "  ".repeat(indent);
    let ty = csharp.map(parse_type);
    match wt {
        WireType::Varint => {
            let v = r.varint().unwrap_or(0);
            let label = match ty.as_ref().map(|t| &t.base) {
                Some(Base::Msg(_)) => "enum", // varint-wire on a named type = enum
                _ => "varint",
            };
            format!("{pad}{field}: {label} {v}\n")
        }
        WireType::I64 => {
            let b = r.read_bytes(8).unwrap_or(&[]);
            format!("{pad}{field}: i64 0x{}\n", hex(b))
        }
        WireType::I32 => {
            let b = r.read_bytes(4).unwrap_or(&[]);
            format!("{pad}{field}: i32 0x{}\n", hex(b))
        }
        WireType::Len => {
            let b = r.len_field().unwrap_or(&[]);
            render_len(field, b, ty.as_ref(), reg, indent)
        }
        WireType::Unknown(o) => format!("{pad}{field}: <unknown wire {o}>\n"),
    }
}

fn render_len(field: u32, b: &[u8], ty: Option<&TypeInfo>, reg: Option<&Registry>, indent: usize) -> String {
    let pad = "  ".repeat(indent);
    if let Some(t) = ty {
        match &t.base {
            Base::Bytes => return format!("{pad}{field}: bytes({}) {}\n", b.len(), hex_trunc(b, 32)),
            Base::Str => return format!("{pad}{field}: string {:?}\n", String::from_utf8_lossy(b)),
            Base::Scalar(_) if t.repeated => {
                let vals = packed_varints(b);
                return format!("{pad}{field}: packed {vals:?}\n");
            }
            Base::Msg(token) => {
                let inner = reg.and_then(|r| r.resolve(token));
                let name = inner
                    .and_then(|m| m.real.clone())
                    .unwrap_or_else(|| leaf(token).to_string());
                let body = dump(b, reg, inner, indent + 1);
                return format!("{pad}{field}: {name} ({} bytes)\n{body}", b.len());
            }
            _ => {}
        }
    }
    // no schema: heuristics
    if !b.is_empty() && looks_like_message(b) {
        let inner = dump(b, reg, None, indent + 1);
        if !inner.contains("<malformed") {
            return format!("{pad}{field}: message ({} bytes)\n{inner}", b.len());
        }
    }
    if let Some(s) = as_utf8(b) {
        return format!("{pad}{field}: string {s:?}\n");
    }
    format!("{pad}{field}: bytes({}) {}\n", b.len(), hex_trunc(b, 32))
}

/// Does this body (at any nesting depth) contain an `Any` whose type key has
/// an interpreter? Used to filter "known" frames from the firehose.
pub fn has_known(buf: &[u8]) -> bool {
    if let Some((url, value)) = any_unwrap(buf) {
        let key = url.rsplit('/').next().unwrap_or(&url);
        return crate::interpret::is_known_key(key) || has_known(value);
    }
    let mut r = Reader::new(buf);
    while !r.eof() {
        let (_, wt) = match r.tag() {
            Some(t) => t,
            None => return false,
        };
        if wt == WireType::Len {
            let b = r.len_field().unwrap_or(&[]);
            if !b.is_empty() && looks_like_message(b) && has_known(b) {
                return true;
            }
        } else if !r.skip(wt) {
            return false;
        }
    }
    false
}

/// Collect every `Any` (type key, value bytes) in a body, at any depth.
/// Used to fire callbacks for the messages a frame carries.
pub fn collect_any(buf: &[u8], out: &mut Vec<(String, Vec<u8>)>) {
    if let Some((url, value)) = any_unwrap(buf) {
        let key = url.rsplit('/').next().unwrap_or(&url).to_string();
        out.push((key, value.to_vec()));
        collect_any(value, out); // nested Any inside the value
        return;
    }
    let mut r = Reader::new(buf);
    while !r.eof() {
        let (_, wt) = match r.tag() {
            Some(t) => t,
            None => return,
        };
        if wt == WireType::Len {
            let b = r.len_field().unwrap_or(&[]);
            if !b.is_empty() && looks_like_message(b) {
                collect_any(b, out);
            }
        } else if !r.skip(wt) {
            return;
        }
    }
}

// ---- google.protobuf.Any detection ---------------------------------------

/// If `buf` is an `Any` (field1 = "type.*/..." string, field2 = value bytes),
/// return (type_url, value_bytes).
fn any_unwrap(buf: &[u8]) -> Option<(String, &[u8])> {
    let mut r = Reader::new(buf);
    let mut url: Option<String> = None;
    let mut value: Option<&[u8]> = None;
    while !r.eof() {
        let (field, wt) = r.tag()?;
        match (field, wt) {
            (1, WireType::Len) => {
                let s = std::str::from_utf8(r.len_field()?).ok()?;
                if !s.starts_with("type.") || !s.contains('/') {
                    return None;
                }
                url = Some(s.to_string());
            }
            (2, WireType::Len) => value = Some(r.len_field()?),
            (_, wt) => {
                if !r.skip(wt) {
                    return None;
                }
            }
        }
    }
    Some((url?, value?))
}

// ---- C# type -> decode plan ----------------------------------------------

enum Base {
    Scalar(Scalar),
    Str,
    Bytes,
    Msg(String), // message or enum token
    Map,
}

enum Scalar {
    Varint,
    Fixed32,
    Fixed64,
}

struct TypeInfo {
    repeated: bool,
    base: Base,
}

fn parse_type(csharp: &str) -> TypeInfo {
    let t = csharp.trim();
    if let Some(inner) = t.strip_prefix("RepeatedField<").and_then(|s| s.strip_suffix('>')) {
        return TypeInfo { repeated: true, base: parse_base(inner) };
    }
    if t.starts_with("MapField<") {
        return TypeInfo { repeated: false, base: Base::Map };
    }
    if let Some(inner) = t.strip_prefix("Nullable<").and_then(|s| s.strip_suffix('>')) {
        return TypeInfo { repeated: false, base: parse_base(inner) };
    }
    TypeInfo { repeated: false, base: parse_base(t) }
}

fn parse_base(t: &str) -> Base {
    match t {
        "int" | "uint" | "long" | "ulong" | "bool" | "sbyte" | "byte" | "short" | "ushort" | "char" => {
            Base::Scalar(Scalar::Varint)
        }
        "float" => Base::Scalar(Scalar::Fixed32),
        "double" => Base::Scalar(Scalar::Fixed64),
        "string" => Base::Str,
        "ByteString" => Base::Bytes,
        other => Base::Msg(other.to_string()),
    }
}

// ---- helpers --------------------------------------------------------------

fn packed_varints(b: &[u8]) -> Vec<u64> {
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

fn as_utf8(b: &[u8]) -> Option<&str> {
    if b.is_empty() {
        return None;
    }
    let s = std::str::from_utf8(b).ok()?;
    if s.chars().all(|c| !c.is_control() || c == '\n' || c == '\t') {
        Some(s)
    } else {
        None
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn hex_trunc(b: &[u8], max: usize) -> String {
    let shown: String = b.iter().take(max).map(|x| format!("{x:02x}")).collect();
    if b.len() > max {
        format!("{shown}…")
    } else {
        shown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // real captured frame body (bytes after the 0x35 length prefix)
    const BODY: &[u8] = &[
        0x0a, 0x33, 0x0a, 0x31, 0x0a, 0x13, 0x74, 0x79, 0x70, 0x65, 0x2e, 0x61, 0x6e, 0x6b, 0x61,
        0x6d, 0x61, 0x2e, 0x63, 0x6f, 0x6d, 0x2f, 0x6b, 0x64, 0x68, 0x12, 0x1a, 0x0a, 0x13, 0x08,
        0xe1, 0x3f, 0x10, 0x68, 0x22, 0x08, 0x8a, 0x03, 0xc5, 0x0f, 0xa4, 0xc3, 0x01, 0x00, 0x28,
        0xab, 0x9d, 0x01, 0x18, 0xe1, 0x3f, 0x20, 0x68,
    ];

    #[test]
    fn unwraps_any_and_decodes_kdh() {
        let reg = Registry::load("proto/messages.json").expect("load registry");
        let out = dump(BODY, Some(&reg), None, 0);
        println!("{out}");
        assert!(out.contains("type.ankama.com/kdh"), "should surface the Any url");
        // 0x61A4 = 24996 (matches the game's "61 A4")
        assert!(out.contains("packed [394, 1989, 24996, 0]"), "should decode packed int64s:\n{out}");
    }

    #[test]
    fn known_filter() {
        assert!(has_known(BODY), "kdh body is known");
        // an Any with an unknown key -> not known
        // field1 "type.ankama.com/zzz", field2 empty
        let unknown = &[
            0x0a, 0x13, 0x74, 0x79, 0x70, 0x65, 0x2e, 0x61, 0x6e, 0x6b, 0x61, 0x6d, 0x61, 0x2e, 0x63,
            0x6f, 0x6d, 0x2f, 0x7a, 0x7a, 0x7a, 0x12, 0x00,
        ];
        assert!(!has_known(unknown), "unknown Any key is not known");
    }
}
