//! Wire key <-> semantic message name.
//!
//! The obfuscated `Any` keys (`kea`, `ksv`, ...) rotate between client builds:
//! the key that meant "price list" in one build means nothing, or something
//! else entirely, in the next. So nothing else in this codebase refers to a
//! message by its wire key. Code says `price_list`; this module is the only
//! place that knows the current key is `kea`.
//!
//! **When a build rotates the keys, this is the only thing to change.**
//! Either edit `DEFAULTS` below, or — without rebuilding — edit `keymap.json`
//! in the repository root:
//!
//! ```json
//! { "price_list": "abc", "chat_message": "xyz" }
//! ```
//!
//! Entries there override the built-in defaults; anything absent falls back.
//! Re-identify a rotated key with `tools/identify.py` or `tools/findvalue.py`
//! (see RUNBOOK part 2 step 5).

use std::collections::HashMap;
use std::sync::OnceLock;

/// Semantic name -> wire `Any` key, as observed on the build noted in RUNBOOK.
///
/// Add a line here when a new message is identified. The semantic name is the
/// contract the rest of the code uses, so choose it for meaning, not for how
/// the current build happens to spell it.
pub const DEFAULTS: &[(&str, &str)] = &[
    // marketplace price ladder (x1 / x10 / x100 / x1000) — see interpret::price_list
    ("price_list", "kea"),
    // chat / trade-channel messages: author, timestamp, free text
    ("chat_message", "ksv"),
    // breaking an item into runes ("brisage") — see interpret::crush_result
    ("crush_result", "kfy"),
    // item instance detail; supplies the uid -> type id the crush result lacks
    ("item_detail", "kev"),
    // the client's "crush it" command — carries the focus, which the result does not
    ("crush_request", "ker"),
    // putting an item into the breaker's slot; carries only the instance uid,
    // the type arrives in the item_detail that answers it
    ("crush_slot_put", "kch"),
    // the whole bag, as a snapshot — see interpret::inventory
    ("inventory", "iss"),
    // one instance has left the bag: crushed, sold, dropped
    ("inventory_remove", "ivf"),
    // a new stack has arrived in the bag — one slot, same shape as a listing's
    ("inventory_add", "iun"),
    // an existing stack changed size: bought more, used some
    ("inventory_quantity", "iul"),
];

/// Where an override file is looked for, relative to the working directory.
pub const OVERRIDE_PATH: &str = "keymap.json";

pub struct KeyMap {
    by_key: HashMap<String, String>,  // wire key  -> semantic name
    by_name: HashMap<String, String>, // semantic  -> wire key
    overridden: usize,
}

impl KeyMap {
    fn build(pairs: Vec<(String, String)>, overridden: usize) -> KeyMap {
        let mut by_key = HashMap::new();
        let mut by_name = HashMap::new();
        for (name, key) in pairs {
            by_key.insert(key.clone(), name.clone());
            by_name.insert(name, key);
        }
        KeyMap { by_key, by_name, overridden }
    }

    /// Built-in defaults, with `keymap.json` applied on top if present.
    pub fn load(path: &str) -> KeyMap {
        let mut pairs: Vec<(String, String)> = DEFAULTS
            .iter()
            .map(|(n, k)| (n.to_string(), k.to_string()))
            .collect();
        let mut overridden = 0;

        if let Ok(text) = std::fs::read_to_string(path) {
            match serde_json::from_str::<HashMap<String, String>>(&text) {
                Ok(over) => {
                    for (name, key) in over {
                        // `_`-prefixed entries are notes for the reader, not messages
                        if name.starts_with('_') {
                            continue;
                        }
                        match pairs.iter_mut().find(|(n, _)| *n == name) {
                            Some(slot) => slot.1 = key,
                            None => pairs.push((name, key)),
                        }
                        overridden += 1;
                    }
                }
                Err(e) => eprintln!("[keymap] {path} is not valid JSON ({e}); using defaults"),
            }
        }
        KeyMap::build(pairs, overridden)
    }

    /// Semantic name for a wire key, if we know the message.
    pub fn name(&self, key: &str) -> Option<&str> {
        self.by_key.get(key).map(|s| s.as_str())
    }

    /// Current wire key for a semantic name.
    pub fn key(&self, name: &str) -> Option<&str> {
        self.by_name.get(name).map(|s| s.as_str())
    }

    pub fn len(&self) -> usize {
        self.by_name.len()
    }

    pub fn overridden(&self) -> usize {
        self.overridden
    }

    /// "price_list=kea chat_message=ksv", for startup logging.
    pub fn summary(&self) -> String {
        let mut v: Vec<String> =
            self.by_name.iter().map(|(n, k)| format!("{n}={k}")).collect();
        v.sort();
        v.join(" ")
    }
}

static KEYMAP: OnceLock<KeyMap> = OnceLock::new();

/// The process-wide mapping. Loaded once, on first use.
pub fn keymap() -> &'static KeyMap {
    KEYMAP.get_or_init(|| KeyMap::load(OVERRIDE_PATH))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip() {
        let m = KeyMap::load("/nonexistent");
        assert_eq!(m.key("price_list"), Some("kea"));
        assert_eq!(m.name("kea"), Some("price_list"));
        assert_eq!(m.name("nope"), None);
        assert_eq!(m.overridden(), 0);
    }

    #[test]
    fn override_file_repoints_a_key() {
        // simulates a build rotating "price_list" from kea to zzz
        let dir = std::env::temp_dir().join("sniff_keymap_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keymap.json");
        std::fs::write(&path, r#"{"price_list":"zzz"}"#).unwrap();

        let m = KeyMap::load(path.to_str().unwrap());
        assert_eq!(m.key("price_list"), Some("zzz"), "override wins");
        assert_eq!(m.name("zzz"), Some("price_list"));
        assert_eq!(m.name("kea"), None, "old key no longer resolves");
        assert_eq!(m.key("chat_message"), Some("ksv"), "untouched entry survives");
        assert_eq!(m.overridden(), 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_new_message_can_be_added_by_file_alone() {
        let dir = std::env::temp_dir().join("sniff_keymap_test2");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keymap.json");
        std::fs::write(&path, r#"{"guild_info":"abc"}"#).unwrap();

        let m = KeyMap::load(path.to_str().unwrap());
        assert_eq!(m.key("guild_info"), Some("abc"));
        assert_eq!(m.name("abc"), Some("guild_info"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn comment_entries_are_ignored() {
        let dir = std::env::temp_dir().join("sniff_keymap_test4");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keymap.json");
        std::fs::write(&path, r#"{"_comment":"notes","price_list":"kea"}"#).unwrap();

        let m = KeyMap::load(path.to_str().unwrap());
        assert_eq!(m.name("notes"), None, "the comment is not a message");
        assert_eq!(m.key("_comment"), None);
        assert_eq!(m.key("price_list"), Some("kea"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn bad_json_falls_back_to_defaults() {
        let dir = std::env::temp_dir().join("sniff_keymap_test3");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("keymap.json");
        std::fs::write(&path, "{ not json").unwrap();

        let m = KeyMap::load(path.to_str().unwrap());
        assert_eq!(m.key("price_list"), Some("kea"), "still usable");
        std::fs::remove_file(&path).ok();
    }
}
