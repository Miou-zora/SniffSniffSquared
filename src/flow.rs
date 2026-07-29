//! Per-direction TCP stream reassembly. Keyed by (src, dst). Lightweight,
//! sequence-aware: appends contiguous segments, buffers out-of-order ones,
//! drops pure retransmits. Enough for a capture on a quiet link; not a full
//! TCP stack.

use crate::framer::{Deframed, Framer};
use std::collections::HashMap;
use std::net::IpAddr;

#[derive(Hash, PartialEq, Eq, Clone, Copy)]
pub struct FlowKey {
    pub src: IpAddr,
    pub sport: u16,
    pub dst: IpAddr,
    pub dport: u16,
}

impl std::fmt::Display for FlowKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{} -> {}:{}", self.src, self.sport, self.dst, self.dport)
    }
}

struct Stream {
    framer: Framer,
    next_seq: Option<u32>,
    pending: HashMap<u32, Vec<u8>>, // out-of-order segments by seq
    announced: bool,
}

impl Stream {
    fn new() -> Self {
        Stream { framer: Framer::new(), next_seq: None, pending: HashMap::new(), announced: false }
    }

    /// Return the locked layout string exactly once (first time after locking).
    fn announce(&mut self) -> Option<String> {
        if self.announced {
            return None;
        }
        let layout = self.framer.locked()?;
        self.announced = true;
        Some(layout)
    }

    fn accept(&mut self, seq: u32, payload: &[u8]) -> Vec<Deframed> {
        if payload.is_empty() {
            return Vec::new();
        }
        // establish baseline on first data segment we see
        let expected = *self.next_seq.get_or_insert(seq);
        if seq_lt(seq, expected) {
            // retransmit of already-consumed data (possibly partial overlap)
            let skip = expected.wrapping_sub(seq) as usize;
            if skip >= payload.len() {
                return Vec::new();
            }
            return self.feed(expected, &payload[skip..]);
        }
        if seq == expected {
            return self.feed(seq, payload);
        }
        // future segment: stash until the gap fills
        self.pending.entry(seq).or_insert_with(|| payload.to_vec());
        Vec::new()
    }

    fn feed(&mut self, seq: u32, payload: &[u8]) -> Vec<Deframed> {
        let mut out = self.framer.push(payload);
        let mut next = seq.wrapping_add(payload.len() as u32);
        // drain any now-contiguous stashed segments
        while let Some(p) = self.pending.remove(&next) {
            out.extend(self.framer.push(&p));
            next = next.wrapping_add(p.len() as u32);
        }
        self.next_seq = Some(next);
        out
    }
}

/// Signed-wraparound "a < b" for TCP sequence numbers.
fn seq_lt(a: u32, b: u32) -> bool {
    (a.wrapping_sub(b) as i32) < 0
}

pub struct Reassembler {
    streams: HashMap<FlowKey, Stream>,
}

impl Reassembler {
    pub fn new() -> Self {
        Reassembler { streams: HashMap::new() }
    }

    pub fn push(&mut self, key: FlowKey, seq: u32, payload: &[u8]) -> Vec<Deframed> {
        self.streams.entry(key).or_insert_with(Stream::new).accept(seq, payload)
    }

    /// First-time-only framing announcement for a flow.
    pub fn announce(&mut self, key: &FlowKey) -> Option<String> {
        self.streams.get_mut(key).and_then(|s| s.announce())
    }
}
