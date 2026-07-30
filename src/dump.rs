//! Message body pretty-printer.
//!
//! - Detects and unwraps `google.protobuf.Any` (`type.ankama.com/<key>`),
//!   resolving `<key>` to a schema and decoding the inner bytes.
//! - When a schema is known, decodes fields by their declared type (packed
//!   repeateds, nested messages, strings) instead of guessing.
//! - Falls back to schema-less heuristics for unknown fields/messages.
//! - A schema resolved from the `Any` key is only a guess: when a declared type
//!   contradicts the wire type actually present, the declaration is dropped for
//!   that field and the mismatch is flagged.

use crate::pb::{looks_like_message, looks_like_text, Reader, WireType};
use crate::registry::{leaf, Msg, Registry};

/// Tag appended to a field whose declared type contradicted the wire. Also
/// counted per-`Any` to surface a mis-joined schema.
const MISMATCH: &str = "  <!schema";

pub fn dump(buf: &[u8], reg: Option<&Registry>, schema: Option<&Msg>, indent: usize) -> String {
    let pad = "  ".repeat(indent);

    // google.protobuf.Any?  field1 = "type.../<key>", field2 = value bytes
    if let Some((url, value)) = any_unwrap(buf) {
        let key = url.rsplit('/').next().unwrap_or(&url);
        let inner_schema = reg.and_then(|r| r.resolve(key));
        let named = inner_schema
            .map(|m| format!(" [{}]", m.real.clone().unwrap_or_else(|| m.obf.clone())))
            .unwrap_or_default();
        let body = dump(value, reg, inner_schema, indent + 1);
        let bad = body.matches(MISMATCH).count();
        let flag = match bad {
            0 => String::new(),
            1 => " <!! schema mismatch on 1 field>".to_string(),
            n => format!(" <!! schema mismatch on {n} fields>"),
        };
        let mut out = format!("{pad}Any <{url}>{named}{flag}\n");
        if let Some(r) = reg {
            if let Some(understood) = crate::interpret::interpret(key, value, r) {
                out.push_str(&format!("{pad}  => {understood}\n"));
            }
        }
        out.push_str(&body);
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
    let declared = csharp.map(parse_type);
    // A schema that disagrees with the wire is worse than none: it pushes
    // strings through the packed-varint path and prints digit soup. Drop it for
    // this field and fall back to the heuristics, but say so.
    let bad = declared.as_ref().map(|t| !wire_matches(t, wt)).unwrap_or(false);
    let note = if bad {
        format!("{MISMATCH}: declared {}>", csharp.unwrap_or_default())
    } else {
        String::new()
    };
    let ty = if bad { None } else { declared };
    match wt {
        WireType::Varint => {
            let v = r.varint().unwrap_or(0);
            format!("{pad}{field}: {}{note}\n", render_varint(v, ty.as_ref()))
        }
        WireType::I64 => {
            let b = r.read_bytes(8).unwrap_or(&[]);
            format!("{pad}{field}: i64 0x{}{note}\n", hex(b))
        }
        WireType::I32 => {
            let b = r.read_bytes(4).unwrap_or(&[]);
            format!("{pad}{field}: i32 0x{}{note}\n", hex(b))
        }
        WireType::Len => {
            let b = r.len_field().unwrap_or(&[]);
            render_len(field, b, ty.as_ref(), reg, indent, &note)
        }
        WireType::Unknown(o) => format!("{pad}{field}: <unknown wire {o}>{note}\n"),
    }
}

/// Render a varint under the declared signedness. Protobuf sign-extends a
/// negative int32/int64 to 64 bits, so the raw u64 reads as ~1.8e19 unless it
/// is reinterpreted.
fn render_varint(v: u64, ty: Option<&TypeInfo>) -> String {
    match ty.map(|t| &t.base) {
        Some(Base::Scalar(Scalar::Bool)) => format!("bool {}", v != 0),
        Some(Base::Scalar(Scalar::Signed)) => format!("varint {}", v as i64),
        Some(Base::Scalar(Scalar::Unsigned)) => format!("varint {v}"),
        // varint-wire on a named type = enum, which is a sign-extended int32
        Some(Base::Msg(_)) => format!("enum {}", v as i64),
        // no usable declaration: show the signed reading when one is plausible
        _ if v >= 1 << 63 => format!("varint {v} ({})", v as i64),
        _ => format!("varint {v}"),
    }
}

fn render_len(
    field: u32,
    b: &[u8],
    ty: Option<&TypeInfo>,
    reg: Option<&Registry>,
    indent: usize,
    note: &str,
) -> String {
    let pad = "  ".repeat(indent);
    if let Some(t) = ty {
        match &t.base {
            Base::Bytes => {
                return format!("{pad}{field}: bytes({}) {}{note}\n", b.len(), hex_trunc(b, 32))
            }
            Base::Str => {
                return format!("{pad}{field}: string {:?}{note}\n", String::from_utf8_lossy(b))
            }
            Base::Scalar(s) if t.repeated => {
                // Packed ints and a string are both length-delimited, so the
                // wire type can't separate them. Printable bytes here mean the
                // schema is mis-joined and this is really text.
                if let Some(text) = as_utf8(b).filter(|_| looks_like_text(b)) {
                    return format!(
                        "{pad}{field}: string {text:?}{MISMATCH}: declared packed, reads as text>\n"
                    );
                }
                return format!("{pad}{field}: packed {}{note}\n", packed_scalars(b, s));
            }
            Base::Msg(token) => {
                let inner = reg.and_then(|r| r.resolve(token));
                let name = inner
                    .and_then(|m| m.real.clone())
                    .unwrap_or_else(|| leaf(token).to_string());
                let body = dump(b, reg, inner, indent + 1);
                return format!("{pad}{field}: {name} ({} bytes){note}\n{body}", b.len());
            }
            _ => {}
        }
    }
    // no schema: heuristics
    if !b.is_empty() && looks_like_message(b) {
        let inner = dump(b, reg, None, indent + 1);
        if !inner.contains("<malformed") {
            return format!("{pad}{field}: message ({} bytes){note}\n{inner}", b.len());
        }
    }
    if let Some(s) = as_utf8(b) {
        return format!("{pad}{field}: string {s:?}{note}\n");
    }
    format!("{pad}{field}: bytes({}) {}{note}\n", b.len(), hex_trunc(b, 32))
}

/// Does the wire type actually present agree with the declared C# type?
fn wire_matches(ty: &TypeInfo, wt: WireType) -> bool {
    match &ty.base {
        // repeated scalars are packed, but an old encoder may write one per tag
        Base::Scalar(s) if ty.repeated => wt == WireType::Len || wt == scalar_wire(s),
        Base::Scalar(s) => wt == scalar_wire(s),
        Base::Str | Base::Bytes | Base::Map => wt == WireType::Len,
        // a named type is a message (Len) or an enum (Varint)
        Base::Msg(_) => wt == WireType::Len || wt == WireType::Varint,
    }
}

fn scalar_wire(s: &Scalar) -> WireType {
    match s {
        Scalar::Signed | Scalar::Unsigned | Scalar::Bool => WireType::Varint,
        Scalar::Fixed32 => WireType::I32,
        Scalar::Fixed64 => WireType::I64,
    }
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
    Signed,   // int32/int64 on the wire: sign-extended, read back as i64
    Unsigned, // uint32/uint64
    Bool,
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
        "int" | "long" | "sbyte" | "short" => Base::Scalar(Scalar::Signed),
        "uint" | "ulong" | "byte" | "ushort" | "char" => Base::Scalar(Scalar::Unsigned),
        "bool" => Base::Scalar(Scalar::Bool),
        "float" => Base::Scalar(Scalar::Fixed32),
        "double" => Base::Scalar(Scalar::Fixed64),
        "string" => Base::Str,
        "ByteString" => Base::Bytes,
        other => Base::Msg(other.to_string()),
    }
}

// ---- helpers --------------------------------------------------------------

/// Decode a packed repeated field, honouring the element's width and sign.
fn packed_scalars(b: &[u8], s: &Scalar) -> String {
    let mut r = Reader::new(b);
    let mut out: Vec<String> = Vec::new();
    while !r.eof() {
        let item = match s {
            Scalar::Signed => r.varint().map(|v| (v as i64).to_string()),
            Scalar::Unsigned => r.varint().map(|v| v.to_string()),
            Scalar::Bool => r.varint().map(|v| (v != 0).to_string()),
            Scalar::Fixed32 => r
                .read_bytes(4)
                .map(|x| f32::from_le_bytes([x[0], x[1], x[2], x[3]]).to_string()),
            Scalar::Fixed64 => r.read_bytes(8).map(|x| {
                f64::from_le_bytes([x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7]]).to_string()
            }),
        };
        match item {
            Some(v) => out.push(v),
            None => break,
        }
    }
    format!("[{}]", out.join(", "))
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

    use crate::registry::Field;

    fn schema(fields: &[(u32, &str)]) -> Msg {
        Msg {
            obf: "test".to_string(),
            real: None,
            fields: fields
                .iter()
                .map(|(num, csharp)| Field { num: *num, csharp: csharp.to_string() })
                .collect(),
        }
    }

    // field 1 varint, sign-extended -20002 (10 bytes)
    const NEG: &[u8] = &[0x08, 0xde, 0xe3, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];

    #[test]
    fn signed_varint_reads_as_negative() {
        let s = schema(&[(1, "long")]);
        let out = dump(NEG, None, Some(&s), 0);
        assert!(out.contains("1: varint -20002"), "declared long must read signed:\n{out}");
        // the same bytes under uint64 really are that huge number
        let u = schema(&[(1, "ulong")]);
        assert!(dump(NEG, None, Some(&u), 0).contains("varint 18446744073709531614"));
    }

    #[test]
    fn schema_less_varint_surfaces_signed_reading() {
        let out = dump(NEG, None, None, 0);
        assert!(out.contains("(-20002)"), "unknown field should hint the signed value:\n{out}");
    }

    #[test]
    fn wire_contradiction_drops_the_declaration() {
        // schema says string, wire carries a varint -> ignore the schema, flag it
        let s = schema(&[(1, "string")]);
        let out = dump(NEG, None, Some(&s), 0);
        assert!(out.contains(MISMATCH), "contradiction must be flagged:\n{out}");
        assert!(out.contains("(-20002)"), "should fall back to the heuristic:\n{out}");
    }

    #[test]
    fn packed_declaration_over_text_is_flagged() {
        // field 1, length-delimited, carrying chat text — the `ksv` case:
        // both a packed repeated and a string are Len, so only the bytes tell
        let mut buf = vec![0x0a, 14];
        buf.extend_from_slice(b"chat text here");
        let s = schema(&[(1, "RepeatedField<long>")]);
        let out = dump(&buf, None, Some(&s), 0);
        assert!(out.contains("\"chat text here\""), "text must survive as text:\n{out}");
        assert!(out.contains(MISMATCH), "mis-joined packed field must be flagged:\n{out}");
        // a genuine packed array of small ints must still decode as numbers
        let real = [0x0a, 0x04, 0x01, 0x02, 0x03, 0x04];
        let out = dump(&real, None, Some(&s), 0);
        assert!(out.contains("packed [1, 2, 3, 4]"), "real packed data unaffected:\n{out}");
        assert!(!out.contains(MISMATCH));
    }

    #[test]
    fn mismatches_are_tallied_on_the_any_header() {
        let reg = Registry::load("proto/messages.json").expect("registry");
        // a well-joined message reports nothing
        let out = dump(BODY, Some(&reg), None, 0);
        assert!(!out.contains("schema mismatch"), "kdh joins cleanly:\n{out}");
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
