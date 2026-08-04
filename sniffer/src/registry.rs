//! Message schema registry, loaded from `proto/messages.json` (produced by
//! tools/gen_proto.py). Maps an obfuscated type token — a full path like
//! `kdh.kdg.kdf`, a bare leaf like `kdh`, or an `Any` URL key — to its
//! build-exact field list (numbers + C# types). Field *names* are not known.

use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone)]
pub struct Field {
    pub num: u32,
    pub csharp: String,
}

pub struct Msg {
    pub obf: String,
    pub real: Option<String>,
    pub fields: Vec<Field>,
}

pub struct Registry {
    msgs: Vec<Msg>,
    by_path: HashMap<String, usize>,
    by_leaf: HashMap<String, usize>,
}

/// Last dotted segment, generic backticks stripped (`kdh.kdg.kdf` -> `kdf`).
pub fn leaf(token: &str) -> &str {
    token
        .split('`')
        .next()
        .unwrap_or(token)
        .rsplit('.')
        .next()
        .unwrap_or(token)
}

impl Registry {
    pub fn load(path: &str) -> Option<Registry> {
        let text = std::fs::read_to_string(path).ok()?;
        let root: Value = serde_json::from_str(&text).ok()?;
        let obj = root.as_object()?;
        let mut msgs = Vec::new();
        let mut by_path = HashMap::new();
        let mut by_leaf = HashMap::new();
        for (path_key, v) in obj {
            let fields = v
                .get("fields")
                .and_then(|f| f.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|f| {
                            Some(Field {
                                num: f.get("num")?.as_u64()? as u32,
                                csharp: f.get("csharp")?.as_str()?.to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let real = v.get("real").and_then(|r| r.as_str()).map(String::from);
            let idx = msgs.len();
            by_path.insert(path_key.clone(), idx);
            by_leaf.entry(leaf(path_key).to_string()).or_insert(idx);
            msgs.push(Msg {
                obf: path_key.clone(),
                real,
                fields,
            });
        }
        Some(Registry {
            msgs,
            by_path,
            by_leaf,
        })
    }

    pub fn len(&self) -> usize {
        self.msgs.len()
    }

    /// Resolve a type token (full path, leaf, or Any key) to its schema.
    pub fn resolve(&self, token: &str) -> Option<&Msg> {
        if let Some(&i) = self.by_path.get(token) {
            return Some(&self.msgs[i]);
        }
        self.by_leaf.get(leaf(token)).map(|&i| &self.msgs[i])
    }
}
