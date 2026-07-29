//! Packet callback system.
//!
//! Register handlers per message key; when a frame carrying that message
//! arrives, the handler fires with the decoded values.
//!
//! ```ignore
//! let mut d = Dispatcher::new();
//! d.on("kdh", |e| println!("kdh a={} batches={:?}", e.values.vars[0], e.values.packs));
//! ```

use crate::interpret::{self, Collected};
use crate::registry::Registry;
use std::collections::HashMap;

/// What a handler receives for one matched message.
pub struct Event<'a> {
    pub key: String,
    pub body: &'a [u8],
    pub values: Collected, // schema-guided varints + packed arrays
}

type Handler = Box<dyn FnMut(&Event)>;

#[derive(Default)]
pub struct Dispatcher {
    handlers: HashMap<String, Vec<Handler>>,
}

impl Dispatcher {
    pub fn new() -> Self {
        Dispatcher::default()
    }

    /// Register a callback for a message key (e.g. "kdh").
    pub fn on(&mut self, key: &str, handler: impl FnMut(&Event) + 'static) {
        self.handlers.entry(key.to_string()).or_default().push(Box::new(handler));
    }

    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }

    /// Fire the handlers registered for `key`, if any.
    pub fn dispatch(&mut self, key: &str, body: &[u8], reg: &Registry) {
        if let Some(hs) = self.handlers.get_mut(key) {
            let values = interpret::values(key, body, reg);
            let ev = Event { key: key.to_string(), body, values };
            for h in hs.iter_mut() {
                h(&ev);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    // the kdh message (an Any value) from a real capture
    const KDH: &[u8] = &[
        0x0a, 0x13, 0x08, 0xe1, 0x3f, 0x10, 0x68, 0x22, 0x08, 0x8a, 0x03, 0xc5, 0x0f, 0xa4, 0xc3,
        0x01, 0x00, 0x28, 0xab, 0x9d, 0x01, 0x18, 0xe1, 0x3f, 0x20, 0x68,
    ];

    #[test]
    fn callback_fires_with_values() {
        let reg = Registry::load("proto/messages.json").expect("registry");
        let got: Rc<RefCell<Option<Collected>>> = Rc::new(RefCell::new(None));
        let sink = got.clone();
        let mut d = Dispatcher::new();
        d.on("kdh", move |e| *sink.borrow_mut() = Some(e.values.clone()));
        // unregistered key must not fire
        d.dispatch("zzz", KDH, &reg);
        assert!(got.borrow().is_none());
        // registered key fires with decoded values
        d.dispatch("kdh", KDH, &reg);
        let v = got.borrow().clone().expect("handler fired");
        assert_eq!(v.vars, vec![8161, 104, 20139, 8161, 104]);
        assert_eq!(v.packs, vec![vec![394, 1989, 24996, 0]]);
    }
}
