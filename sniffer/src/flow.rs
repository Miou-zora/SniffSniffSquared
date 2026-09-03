//! Per-direction TCP stream reassembly. Keyed by (src, dst). Lightweight,
//! sequence-aware: appends contiguous segments, buffers out-of-order ones,
//! drops pure retransmits. Enough for a capture on a quiet link; not a full
//! TCP stack.

use crate::framer::{Deframed, Framer};
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::net::IpAddr;
use std::time::{Duration, Instant};

/// How long a hole may stay open before the segment is presumed lost for good.
/// Genuine reordering resolves within an RTT; a segment the capture missed is
/// never retransmitted, because the real client received it fine.
const GAP_TIMEOUT: Duration = Duration::from_secs(2);

/// Ceilings on what one hole may hold, so a quiet direction still recovers and
/// memory stays bounded whatever the clock does.
const MAX_PENDING_BYTES: usize = 256 * 1024;
const MAX_PENDING_SEGMENTS: usize = 64;

#[derive(Hash, PartialEq, Eq, Clone, Copy)]
pub struct FlowKey {
    pub src: IpAddr,
    pub sport: u16,
    pub dst: IpAddr,
    pub dport: u16,
}

impl std::fmt::Display for FlowKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}:{} -> {}:{}",
            self.src, self.sport, self.dst, self.dport
        )
    }
}

struct Stream {
    framer: Framer,
    next_seq: Option<u32>,
    pending: HashMap<u32, Vec<u8>>, // out-of-order segments by seq
    pending_bytes: usize,
    hole_since: Option<Instant>,
    skipped: Option<u32>, // bytes given up on, reported once
    announced: bool,
}

impl Stream {
    fn new() -> Self {
        Stream {
            framer: Framer::new(),
            next_seq: None,
            pending: HashMap::new(),
            pending_bytes: 0,
            hole_since: None,
            skipped: None,
            announced: false,
        }
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

    fn accept(&mut self, seq: u32, payload: &[u8], now: Instant) -> Vec<Deframed> {
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
        if let Entry::Vacant(slot) = self.pending.entry(seq) {
            slot.insert(payload.to_vec());
            self.pending_bytes += payload.len();
        }
        self.hole_since.get_or_insert(now);
        if self.gap_is_lost(now) {
            self.abandon_gap(expected)
        } else {
            Vec::new()
        }
    }

    /// A hole the capture will never see filled: too old, or holding more than
    /// we are willing to buffer behind it.
    fn gap_is_lost(&self, now: Instant) -> bool {
        self.pending_bytes >= MAX_PENDING_BYTES
            || self.pending.len() >= MAX_PENDING_SEGMENTS
            || self
                .hole_since
                .is_some_and(|since| now.duration_since(since) >= GAP_TIMEOUT)
    }

    /// Give up on the missing bytes and restart from the oldest segment we did
    /// see. The framer's buffer ends mid-frame and the new data starts
    /// mid-frame too, so it has to find a boundary again before it can decode.
    fn abandon_gap(&mut self, expected: u32) -> Vec<Deframed> {
        let Some(target) = self.earliest_pending() else {
            return Vec::new();
        };
        let payload = match self.pending.remove(&target) {
            Some(p) => p,
            None => return Vec::new(),
        };
        self.pending_bytes -= payload.len();
        self.skipped = Some(target.wrapping_sub(expected));
        self.hole_since = None;
        self.framer.resync();
        self.next_seq = Some(target);
        self.feed(target, &payload)
    }

    /// Lowest stashed sequence number, comparing with wraparound rather than
    /// numerically — the stash spans at most a few hundred KB, so the pairwise
    /// comparison is well defined.
    fn earliest_pending(&self) -> Option<u32> {
        self.pending
            .keys()
            .copied()
            .reduce(|a, b| if seq_lt(a, b) { a } else { b })
    }

    fn feed(&mut self, seq: u32, payload: &[u8]) -> Vec<Deframed> {
        let mut out = self.framer.push(payload);
        let mut next = seq.wrapping_add(payload.len() as u32);
        // drain any now-contiguous stashed segments
        while let Some(p) = self.pending.remove(&next) {
            self.pending_bytes -= p.len();
            out.extend(self.framer.push(&p));
            next = next.wrapping_add(p.len() as u32);
        }
        self.next_seq = Some(next);
        if self.pending.is_empty() {
            self.hole_since = None;
        }
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
        Reassembler {
            streams: HashMap::new(),
        }
    }

    pub fn push(&mut self, key: FlowKey, seq: u32, payload: &[u8]) -> Vec<Deframed> {
        self.push_at(key, seq, payload, Instant::now())
    }

    /// `push` with the clock supplied, so gap expiry is testable.
    pub fn push_at(
        &mut self,
        key: FlowKey,
        seq: u32,
        payload: &[u8],
        now: Instant,
    ) -> Vec<Deframed> {
        self.streams
            .entry(key)
            .or_insert_with(Stream::new)
            .accept(seq, payload, now)
    }

    /// Bytes lost to a gap this flow just gave up on, reported once.
    pub fn take_skipped(&mut self, key: &FlowKey) -> Option<u32> {
        self.streams.get_mut(key).and_then(|s| s.skipped.take())
    }

    /// First-time-only framing announcement for a flow.
    pub fn announce(&mut self, key: &FlowKey) -> Option<String> {
        self.streams.get_mut(key).and_then(|s| s.announce())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::testdata::kdh_frame;

    /// `frames` whole captured frames back to back.
    fn segment(frames: usize) -> Vec<u8> {
        kdh_frame().repeat(frames)
    }

    fn key() -> FlowKey {
        FlowKey {
            src: "10.0.0.1".parse().unwrap(),
            sport: 5555,
            dst: "10.0.0.2".parse().unwrap(),
            dport: 40000,
        }
    }

    /// A segment the capture never saw must not silence the stream forever.
    /// The kernel drops segments under load and TCP does not retransmit them
    /// for us, because the real client received them fine.
    #[test]
    fn a_missed_segment_does_not_deadlock_the_stream() {
        let mut re = Reassembler::new();
        let (k, seq0, t0) = (key(), 1000u32, Instant::now());

        let seg = segment(4);
        let step = seg.len() as u32;
        assert_eq!(
            re.push_at(k, seq0, &seg, t0).len(),
            4,
            "framing should lock"
        );

        // segment 1 is missed; segment 2 waits, in case the hole still fills
        assert_eq!(re.push_at(k, seq0 + step * 2, &seg, t0).len(), 0, "stashed");

        // it never fills, so later segments must not be lost along with it
        let later = t0 + GAP_TIMEOUT;
        let mut after = 0;
        for i in 3..8 {
            after += re.push_at(k, seq0 + step * i, &seg, later).len();
        }
        assert!(
            after > 0,
            "stream deadlocked: five segments after one missed segment yielded no frames"
        );
    }

    /// The bytes given up on are reported, so a hole in the capture is visible
    /// rather than silent.
    #[test]
    fn abandoning_a_gap_reports_the_bytes_lost() {
        let mut re = Reassembler::new();
        let (k, seq0, t0) = (key(), 1000u32, Instant::now());

        let seg = segment(4);
        let step = seg.len() as u32;
        re.push_at(k, seq0, &seg, t0);
        assert_eq!(re.take_skipped(&k), None, "nothing lost yet");

        re.push_at(k, seq0 + step * 2, &seg, t0);
        re.push_at(k, seq0 + step * 3, &seg, t0 + GAP_TIMEOUT);

        assert_eq!(re.take_skipped(&k), Some(step), "one segment's worth");
        assert_eq!(re.take_skipped(&k), None, "reported once only");
    }

    /// With no traffic to age the hole out, the stash must still not grow
    /// without bound.
    #[test]
    fn a_gap_is_abandoned_on_volume_even_with_a_frozen_clock() {
        let mut re = Reassembler::new();
        let (k, seq0, t0) = (key(), 1000u32, Instant::now());

        let seg = segment(4);
        let step = seg.len() as u32;
        re.push_at(k, seq0, &seg, t0);

        let mut after = 0;
        for i in 2..(MAX_PENDING_SEGMENTS as u32 + 4) {
            after += re.push_at(k, seq0 + step * i, &seg, t0).len();
        }
        assert!(after > 0, "the segment ceiling never fired");
    }

    /// Genuinely out-of-order delivery must still reassemble once the hole
    /// fills — that is what `pending` is for.
    #[test]
    fn an_out_of_order_segment_reassembles_when_the_hole_fills() {
        let mut re = Reassembler::new();
        let (k, seq0, t0) = (key(), 1000u32, Instant::now());

        let seg = segment(4);
        let step = seg.len() as u32;
        re.push_at(k, seq0, &seg, t0);

        assert_eq!(re.push_at(k, seq0 + step * 2, &seg, t0).len(), 0, "stashed");
        assert_eq!(
            re.push_at(k, seq0 + step, &seg, t0).len(),
            8,
            "the filler plus the stashed segment"
        );
        assert_eq!(re.take_skipped(&k), None, "nothing was given up on");
    }

    /// End to end on real bytes: the captured `kdh` price-list frame from
    /// `docs/observations.md`, the same one `tools/replay.py` sends. Segments
    /// cut across frames the way real ones do, so the stream resumes mid-frame
    /// after the loss — a resync that trusted that offset would read a length
    /// out of the middle of a frame and emit garbage.
    #[test]
    fn recovers_onto_a_real_frame_boundary() {
        let frame = kdh_frame();
        let wire = frame.repeat(20);
        let segs: Vec<&[u8]> = wire.chunks(100).collect(); // not frame-aligned
        assert!(100 % frame.len() != 0, "segments must cut across frames");

        let mut re = Reassembler::new();
        let (k, seq0, t0) = (key(), 1000u32, Instant::now());
        let seq_of = |i: usize| seq0 + (i as u32) * 100;

        let mut before = 0;
        for (i, seg) in segs.iter().enumerate().take(3) {
            before += re.push_at(k, seq_of(i), seg, t0).len();
        }
        assert!(before > 0, "framing should lock and emit");

        // segment 3 is lost; the rest arrive a second apart and the hole,
        // aging as they do, is eventually given up on
        let mut out = Vec::new();
        for (i, seg) in segs.iter().enumerate().skip(4) {
            let now = t0 + Duration::from_secs(i as u64 - 3);
            out.extend(re.push_at(k, seq_of(i), seg, now));
        }

        assert!(
            !out.is_empty(),
            "no frames recovered after the lost segment"
        );
        let url = b"type.ankama.com/kdh";
        for d in &out {
            assert!(
                d.body.windows(url.len()).any(|w| w == url),
                "resynchronised onto a false boundary — frame body is garbage"
            );
        }
    }

    /// A pure retransmit of data already consumed must not be fed twice.
    #[test]
    fn a_retransmit_is_dropped() {
        let mut re = Reassembler::new();
        let (k, seq0, t0) = (key(), 1000u32, Instant::now());

        let seg = segment(4);
        re.push_at(k, seq0, &seg, t0);
        assert_eq!(
            re.push_at(k, seq0, &seg, t0).len(),
            0,
            "retransmit must not re-emit"
        );
    }
}
