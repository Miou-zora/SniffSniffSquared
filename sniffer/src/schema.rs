//! Message shapes, in data rather than in Rust.
//!
//! A client update rotates the obfuscated wire keys *and* the protobuf field
//! numbers inside them — the 2026-08-04 one moved a number in every message
//! `interpret.rs` reads but `crush_slot_put`. Keys already lived in
//! `keymap.json`; this puts the structure there too, so a rotation is a JSON
//! edit rather than a rebuild.
//!
//! `schema.json` describes each message as a list of fields: number, kind,
//! whether it repeats, and for a submessage which definition it points at.
//! Walking it produces a `Node` — names to values — and the small adapters in
//! `interpret.rs` turn a `Node` into the typed struct the rest of the code
//! wants. Meaning stays in Rust: "an empty ladder is not a price message",
//! "quantity absent means one", "a negative delta is a removal". Those are
//! decisions, not structure.
//!
//! **The risk this file carries.** A schema that is subtly wrong parses to
//! something plausible instead of failing, which is worse than not parsing at
//! all — the same trap `proto/messages.json` falls into (see CLAUDE.md). Two
//! things hold it down. `validate` rejects a schema that is internally
//! inconsistent at load, loudly, before a byte is read. And every message is
//! pinned by a test over real captured bytes under *two* schemas, this build's
//! and the previous one's, so a shape that only appears to work does not
//! survive the suite.

use std::collections::HashMap;
use std::sync::OnceLock;

/// Shipped alongside the binary and loaded from disk at startup, so editing it
/// needs no rebuild. Compiled in as well, purely so a sniffer started from the
/// wrong directory says what is wrong instead of decoding nothing.
const BUILTIN: &str = include_str!("../schema.json");

/// Where the schema is looked for, relative to the working directory.
pub const PATH: &str = "schema.json";

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    /// A base-128 integer. Read as `u64`; adapters cast when a field is signed.
    Varint,
    /// A length-delimited run of varints — the price ladder.
    Packed,
    /// Four little-endian bytes as `f32` — the crush yield.
    F32,
    /// A nested message, parsed with the definition named by `of`.
    Message,
}

impl Kind {
    fn parse(s: &str) -> Option<Kind> {
        match s {
            "varint" => Some(Kind::Varint),
            "packed" => Some(Kind::Packed),
            "f32" => Some(Kind::F32),
            "message" => Some(Kind::Message),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Field {
    pub number: u32,
    pub name: String,
    pub kind: Kind,
    pub repeated: bool,
    /// Definition name for `Kind::Message`, empty otherwise.
    pub of: String,
}

#[derive(Debug, Clone, Default)]
pub struct Def {
    pub fields: Vec<Field>,
}

impl Def {
    fn field(&self, number: u32) -> Option<&Field> {
        self.fields.iter().find(|f| f.number == number)
    }
}

#[derive(Debug, Clone)]
pub enum Value {
    Uint(u64),
    Float(f32),
    List(Vec<u64>),
    Msg(Node),
}

/// One parsed message: field name to value, in wire order, repeats included.
#[derive(Debug, Clone, Default)]
pub struct Node {
    entries: Vec<(String, Value)>,
}

impl Node {
    /// First value under `name`.
    fn first(&self, name: &str) -> Option<&Value> {
        self.entries.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    /// Every value under `name`, in wire order. Empty when absent — a repeated
    /// field that never arrived and one that arrived zero times are the same
    /// thing on the wire, and no caller here distinguishes them.
    pub fn all(&self, name: &str) -> Vec<&Value> {
        self.entries
            .iter()
            .filter(|(n, _)| n == name)
            .map(|(_, v)| v)
            .collect()
    }

    pub fn uint(&self, name: &str) -> Option<u64> {
        match self.first(name)? {
            Value::Uint(v) => Some(*v),
            _ => None,
        }
    }

    pub fn f32(&self, name: &str) -> Option<f32> {
        match self.first(name)? {
            Value::Float(v) => Some(*v),
            _ => None,
        }
    }

    pub fn list(&self, name: &str) -> Option<Vec<u64>> {
        match self.first(name)? {
            Value::List(v) => Some(v.clone()),
            _ => None,
        }
    }

    pub fn msg(&self, name: &str) -> Option<&Node> {
        match self.first(name)? {
            Value::Msg(n) => Some(n),
            _ => None,
        }
    }

    /// Every submessage under `name`. Non-message values under that name are
    /// skipped rather than failing: a schema pointing a repeated name at mixed
    /// kinds is a schema bug, and `validate` is where it should be caught.
    pub fn msgs(&self, name: &str) -> Vec<&Node> {
        self.all(name)
            .into_iter()
            .filter_map(|v| match v {
                Value::Msg(n) => Some(n),
                _ => None,
            })
            .collect()
    }
}

#[derive(Debug)]
pub struct Schema {
    defs: HashMap<String, Def>,
    source: String,
}

impl Schema {
    /// Parse and validate. `Err` carries a message meant to be printed as-is.
    pub fn parse(text: &str, source: &str) -> Result<Schema, String> {
        let raw: HashMap<String, serde_json::Value> =
            serde_json::from_str(text).map_err(|e| format!("{source} is not valid JSON: {e}"))?;

        let mut defs = HashMap::new();
        for (name, body) in raw {
            // `_`-prefixed entries are notes for the reader, as in keymap.json
            if name.starts_with('_') {
                continue;
            }
            let list = body
                .get("fields")
                .and_then(|f| f.as_array())
                .ok_or_else(|| format!("{source}: `{name}` has no `fields` array"))?;

            let mut fields = Vec::new();
            for f in list {
                let at = |k: &str| f.get(k);
                let number = at("n")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| format!("{source}: `{name}` has a field with no `n`"))?;
                let fname = at("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| format!("{source}: `{name}` field {number} has no `name`"))?;
                let kind_str = at("kind").and_then(|v| v.as_str()).unwrap_or("varint");
                let kind = Kind::parse(kind_str).ok_or_else(|| {
                    format!("{source}: `{name}.{fname}` has unknown kind `{kind_str}`")
                })?;
                let of = at("of").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if kind == Kind::Message && of.is_empty() {
                    return Err(format!(
                        "{source}: `{name}.{fname}` is a message with no `of`"
                    ));
                }
                fields.push(Field {
                    number: number as u32,
                    name: fname.to_string(),
                    kind,
                    repeated: at("repeated").and_then(|v| v.as_bool()).unwrap_or(false),
                    of,
                });
            }
            defs.insert(name, Def { fields });
        }

        let s = Schema {
            defs,
            source: source.to_string(),
        };
        s.validate()?;
        Ok(s)
    }

    /// Catch the schema mistakes that would otherwise parse to something
    /// plausible: a dangling submessage reference, two fields sharing a number
    /// (the second would never be reached), and two fields sharing a name
    /// within one definition (an adapter asking for it gets whichever came
    /// first, silently).
    fn validate(&self) -> Result<(), String> {
        for (name, def) in &self.defs {
            let mut numbers: Vec<u32> = def.fields.iter().map(|f| f.number).collect();
            numbers.sort_unstable();
            let before = numbers.len();
            numbers.dedup();
            if numbers.len() != before {
                return Err(format!("{}: `{name}` reuses a field number", self.source));
            }

            let mut names: Vec<&str> = def.fields.iter().map(|f| f.name.as_str()).collect();
            names.sort_unstable();
            let before = names.len();
            names.dedup();
            if names.len() != before {
                return Err(format!("{}: `{name}` reuses a field name", self.source));
            }

            for f in &def.fields {
                if f.kind == Kind::Message && !self.defs.contains_key(&f.of) {
                    return Err(format!(
                        "{}: `{name}.{}` points at `{}`, which is not defined",
                        self.source, f.name, f.of
                    ));
                }
            }
        }
        Ok(())
    }

    /// Parse `body` as the named message. `None` when the definition is absent
    /// or the bytes do not decode as protobuf at all.
    pub fn read(&self, message: &str, body: &[u8]) -> Option<Node> {
        self.read_def(self.defs.get(message)?, body, 0)
    }

    /// Depth-limited so a schema that points a definition at itself cannot
    /// recurse forever on hostile or garbled bytes.
    fn read_def(&self, def: &Def, body: &[u8], depth: u32) -> Option<Node> {
        if depth > 16 {
            return None;
        }
        let mut node = Node::default();
        let mut r = crate::pb::Reader::new(body);
        while !r.eof() {
            let (number, wt) = r.tag()?;
            let Some(field) = def.field(number) else {
                if !r.skip(wt) {
                    return None;
                }
                continue;
            };
            // A field whose wire type disagrees with the schema is the schema
            // being wrong about this build. Skipping keeps the rest of the
            // message readable; `interpret.rs` then reports the missing piece.
            let value = match (field.kind, wt) {
                (Kind::Varint, crate::pb::WireType::Varint) => Value::Uint(r.varint()?),
                (Kind::Packed, crate::pb::WireType::Len) => Value::List(packed(r.len_field()?)),
                (Kind::F32, crate::pb::WireType::I32) => {
                    let b = r.read_bytes(4)?;
                    Value::Float(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                }
                (Kind::Message, crate::pb::WireType::Len) => {
                    let inner = r.len_field()?;
                    match self.defs.get(&field.of) {
                        Some(d) => match self.read_def(d, inner, depth + 1) {
                            Some(n) => Value::Msg(n),
                            // One unreadable submessage costs that submessage,
                            // not the listing around it — a bag with one odd
                            // slot must not read as an empty bag.
                            None => continue,
                        },
                        None => continue,
                    }
                }
                (_, wt) => {
                    if !r.skip(wt) {
                        return None;
                    }
                    continue;
                }
            };
            if !field.repeated {
                node.entries.retain(|(n, _)| n != &field.name);
            }
            node.entries.push((field.name.clone(), value));
        }
        Some(node)
    }

    pub fn len(&self) -> usize {
        self.defs.len()
    }

    pub fn source(&self) -> &str {
        &self.source
    }
}

fn packed(b: &[u8]) -> Vec<u64> {
    let mut r = crate::pb::Reader::new(b);
    let mut out = Vec::new();
    while !r.eof() {
        match r.varint() {
            Some(v) => out.push(v),
            None => break,
        }
    }
    out
}

static SCHEMA: OnceLock<Schema> = OnceLock::new();

/// The process-wide schema: `schema.json` from the working directory, falling
/// back to the copy compiled in from the same file.
///
/// A broken file on disk falls back rather than aborting — the sniffer's job is
/// to keep capturing, and `packets` fills correctly whatever the schema says.
pub fn schema() -> &'static Schema {
    SCHEMA.get_or_init(|| {
        if let Ok(text) = std::fs::read_to_string(PATH) {
            match Schema::parse(&text, PATH) {
                Ok(s) => return s,
                Err(e) => eprintln!("[schema] {e}; using the built-in copy"),
            }
        }
        Schema::parse(BUILTIN, "built-in").expect("the compiled-in schema must be valid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(json: &str) -> Schema {
        Schema::parse(json, "test").expect("valid")
    }

    fn err(json: &str) -> String {
        Schema::parse(json, "test").expect_err("should be rejected")
    }

    /// The file that actually ships must load, or the sniffer starts blind.
    #[test]
    fn builtin_schema_is_valid() {
        let s = Schema::parse(BUILTIN, "built-in").expect("ships valid");
        for m in [
            "price_list",
            "item_detail",
            "inventory",
            "inventory_add",
            "inventory_quantity",
            "inventory_remove",
            "crush_slot",
            "crush_result",
        ] {
            assert!(s.defs.contains_key(m), "{m} is missing from schema.json");
        }
    }

    #[test]
    fn dangling_submessage_is_rejected() {
        let e = err(r#"{"a":{"fields":[{"n":1,"name":"x","kind":"message","of":"nope"}]}}"#);
        assert!(e.contains("not defined"), "{e}");
    }

    #[test]
    fn message_without_a_target_is_rejected() {
        let e = err(r#"{"a":{"fields":[{"n":1,"name":"x","kind":"message"}]}}"#);
        assert!(e.contains("no `of`"), "{e}");
    }

    /// The second definition of a number is unreachable, so it is a mistake
    /// rather than an override.
    #[test]
    fn duplicate_field_number_is_rejected() {
        let e = err(r#"{"a":{"fields":[{"n":1,"name":"x"},{"n":1,"name":"y"}]}}"#);
        assert!(e.contains("reuses a field number"), "{e}");
    }

    /// Two fields under one name would make `uint()` return whichever the
    /// walker saw first — a silent wrong answer, which is the failure mode this
    /// whole file has to avoid.
    #[test]
    fn duplicate_field_name_is_rejected() {
        let e = err(r#"{"a":{"fields":[{"n":1,"name":"x"},{"n":2,"name":"x"}]}}"#);
        assert!(e.contains("reuses a field name"), "{e}");
    }

    #[test]
    fn unknown_kind_is_rejected() {
        let e = err(r#"{"a":{"fields":[{"n":1,"name":"x","kind":"sint32"}]}}"#);
        assert!(e.contains("unknown kind"), "{e}");
    }

    #[test]
    fn comment_entries_are_ignored() {
        let s = ok(r#"{"_note":"hello","a":{"fields":[{"n":1,"name":"x"}]}}"#);
        assert_eq!(s.len(), 1);
    }

    /// An unknown field number is skipped, not fatal — every real message
    /// carries fields nothing here has been taught to read.
    #[test]
    fn unknown_fields_are_skipped() {
        let s = ok(r#"{"a":{"fields":[{"n":1,"name":"x"}]}}"#);
        // field 1 varint 7, then field 2 varint 9 which the schema omits
        let n = s.read("a", &[0x08, 0x07, 0x10, 0x09]).expect("parses");
        assert_eq!(n.uint("x"), Some(7));
    }

    /// A schema claiming varint where the wire says length-delimited must not
    /// invent a number.
    #[test]
    fn wire_type_disagreement_yields_nothing_for_that_field() {
        let s = ok(r#"{"a":{"fields":[{"n":1,"name":"x"}]}}"#);
        let n = s.read("a", &[0x0a, 0x02, 0x01, 0x02]).expect("still walks");
        assert_eq!(n.uint("x"), None, "no value rather than a wrong one");
    }

    #[test]
    fn a_non_repeated_field_keeps_the_last_copy() {
        let s = ok(r#"{"a":{"fields":[{"n":1,"name":"x"}]}}"#);
        let n = s.read("a", &[0x08, 0x07, 0x08, 0x09]).expect("parses");
        assert_eq!(n.uint("x"), Some(9), "protobuf: last wins");
        assert_eq!(n.all("x").len(), 1);
    }

    #[test]
    fn a_repeated_field_keeps_every_copy() {
        let s = ok(r#"{"a":{"fields":[{"n":1,"name":"x","repeated":true}]}}"#);
        let n = s.read("a", &[0x08, 0x07, 0x08, 0x09]).expect("parses");
        assert_eq!(n.all("x").len(), 2);
    }

    #[test]
    fn unknown_message_name_is_none() {
        assert!(ok(r#"{"a":{"fields":[]}}"#).read("b", &[]).is_none());
    }
}
