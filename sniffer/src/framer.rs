//! Adaptive deframer.
//!
//! `FrameDelimiter` prefixes each frame with a length header, but the exact
//! header width (and whether the length counts itself, and whether a transport
//! discriminator byte precedes the `Frame` protobuf) is not pinned down from
//! the static dump. So we try a small set of candidate layouts against real
//! bytes and lock the one that yields consecutive parseable Frames.

use crate::frame::Frame;

#[derive(Debug, Clone, Copy)]
enum Header {
    Varint,
    U16Be,
    U32Be,
}

#[derive(Debug, Clone, Copy)]
struct Layout {
    header: Header,
    includes_self: bool,
    lead_skip: usize, // discriminator/compression bytes before the Frame protobuf
}

const CANDIDATES: &[Layout] = &[
    Layout {
        header: Header::Varint,
        includes_self: false,
        lead_skip: 0,
    },
    Layout {
        header: Header::Varint,
        includes_self: false,
        lead_skip: 1,
    },
    Layout {
        header: Header::U16Be,
        includes_self: false,
        lead_skip: 0,
    },
    Layout {
        header: Header::U16Be,
        includes_self: false,
        lead_skip: 1,
    },
    Layout {
        header: Header::U16Be,
        includes_self: true,
        lead_skip: 0,
    },
    Layout {
        header: Header::U32Be,
        includes_self: false,
        lead_skip: 0,
    },
    Layout {
        header: Header::U32Be,
        includes_self: false,
        lead_skip: 1,
    },
];

/// Consecutive parseable frames that confirm a frame boundary. Same bar
/// `detect` uses to lock a layout in the first place.
const CONFIRM: usize = 3;

/// How much unrecognised data a resynchronising framer will hold while looking
/// for a boundary. A whole `iuz` catalogue message is ~80 KB, so this is room
/// for several before the oldest bytes are dropped.
const MAX_RESYNC_BUF: usize = 1024 * 1024;

/// How far into an unrecognised buffer to look for a first frame boundary.
/// Comfortably past the largest frame seen on the wire — an `iuz` catalogue is
/// ~80 KB — so a capture that starts inside one still finds the next.
const MAX_DETECT_SCAN: usize = 128 * 1024;

/// One deframed frame: the raw body bytes plus a decoded Frame if it parsed.
pub struct Deframed {
    pub body: Vec<u8>,
    pub frame: Option<Frame>,
}

pub struct Framer {
    buf: Vec<u8>,
    layout: Option<Layout>,
    resyncing: bool,
}

impl Framer {
    pub fn new() -> Self {
        Framer {
            buf: Vec::new(),
            layout: None,
            resyncing: false,
        }
    }

    pub fn locked(&self) -> Option<String> {
        self.layout.map(|l| {
            format!(
                "{:?} includes_self={} lead_skip={}",
                l.header, l.includes_self, l.lead_skip
            )
        })
    }

    /// Drop everything buffered and hunt for a frame boundary in what comes
    /// next. Called when the reassembler gives up on a gap: the bytes after a
    /// segment the capture never saw start mid-frame, and reading a length
    /// from the middle of one yields a garbage length.
    pub fn resync(&mut self) {
        self.buf.clear();
        self.resyncing = self.layout.is_some();
    }

    pub fn push(&mut self, data: &[u8]) -> Vec<Deframed> {
        self.buf.extend_from_slice(data);
        if self.layout.is_none() {
            match detect_at(&self.buf) {
                Some((off, layout)) => {
                    self.buf.drain(0..off);
                    self.layout = Some(layout);
                }
                // Nothing recognisable yet. Keep buffering — but a stream that
                // never resolves must not grow without bound.
                None if self.buf.len() > MAX_RESYNC_BUF => {
                    let excess = self.buf.len() - MAX_RESYNC_BUF;
                    self.buf.drain(0..excess);
                }
                None => {}
            }
        }
        if self.resyncing {
            match self.layout.and_then(|l| find_boundary(&self.buf, l)) {
                Some(off) => {
                    self.buf.drain(0..off);
                    self.resyncing = false;
                }
                None => {
                    // No boundary yet — keep buffering, but never without bound.
                    if self.buf.len() > MAX_RESYNC_BUF {
                        let excess = self.buf.len() - MAX_RESYNC_BUF;
                        self.buf.drain(0..excess);
                    }
                    return Vec::new();
                }
            }
        }
        let mut out = Vec::new();
        if let Some(layout) = self.layout {
            while let Some((consumed, body)) = read_one(&self.buf, layout) {
                let frame = Frame::parse(&body);
                out.push(Deframed { body, frame });
                self.buf.drain(0..consumed);
            }
        }
        out
    }
}

/// Read the header at `buf[0..]`. Returns (header_len, payload_len).
fn read_header(buf: &[u8], h: Header) -> Option<(usize, usize)> {
    match h {
        Header::Varint => {
            let mut val = 0u64;
            let mut shift = 0;
            for (i, &b) in buf.iter().enumerate().take(5) {
                val |= ((b & 0x7f) as u64) << shift;
                if b & 0x80 == 0 {
                    return Some((i + 1, val as usize));
                }
                shift += 7;
            }
            None
        }
        Header::U16Be => {
            if buf.len() < 2 {
                return None;
            }
            Some((2, u16::from_be_bytes([buf[0], buf[1]]) as usize))
        }
        Header::U32Be => {
            if buf.len() < 4 {
                return None;
            }
            Some((
                4,
                u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize,
            ))
        }
    }
}

/// Try to read one framed body from the front of `buf` using `layout`.
/// Returns (bytes_consumed, frame_body).
fn read_one(buf: &[u8], layout: Layout) -> Option<(usize, Vec<u8>)> {
    let (hlen, raw_len) = read_header(buf, layout.header)?;
    if raw_len == 0 || raw_len > 8 * 1024 * 1024 {
        return None;
    }
    let payload_len = if layout.includes_self {
        raw_len.checked_sub(hlen)?
    } else {
        raw_len
    };
    let total = hlen + payload_len;
    if buf.len() < total {
        return None; // wait for more bytes
    }
    let mut body = &buf[hlen..total];
    if layout.lead_skip > 0 {
        body = body.get(layout.lead_skip..)?;
    }
    Some((total, body.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::Frame;

    // Event{ Payload{ id=1234, data = <message{ field1 varint 42 }> } }
    // Payload bytes: 08 D2 09 | 12 02 08 2A
    // Frame(Event=field3): 1A 07 <payload>
    // len-prefixed (varint 9): 09 1A 07 08 D2 09 12 02 08 2A
    const ONE: &[u8] = &[0x09, 0x1A, 0x07, 0x08, 0xD2, 0x09, 0x12, 0x02, 0x08, 0x2A];

    fn stream(n: usize) -> Vec<u8> {
        let mut s = Vec::new();
        for _ in 0..n {
            s.extend_from_slice(ONE);
        }
        s
    }

    #[test]
    fn deframes_and_decodes() {
        let mut f = Framer::new();
        let out = f.push(&stream(4)); // >=3 frames so detection locks
        assert_eq!(out.len(), 4, "should deframe four frames");
        match &out[0].frame {
            Some(Frame::Event(p)) => {
                assert_eq!(p.id, 1234);
                assert_eq!(p.data, vec![0x08, 0x2A]);
            }
            other => panic!("expected Event, got {other:?}"),
        }
        assert!(f.locked().is_some());
    }

    /// After a lost segment the stream resumes at an arbitrary byte. The
    /// partial frame at the head must not be read as a length, and the frames
    /// behind it must come back whole.
    ///
    /// Real captured bytes: a frame boundary is only recognisable by what a
    /// real message looks like, so a hand-built frame cannot exercise this.
    #[test]
    fn resync_recovers_whole_frames_after_a_partial_head() {
        let frame = crate::testdata::kdh_frame();
        let mut f = Framer::new();
        assert_eq!(f.push(&frame.repeat(4)).len(), 4);

        f.resync();
        let mut resumed = frame[3..].to_vec(); // tail of a frame never seen whole
        resumed.extend_from_slice(&frame.repeat(4));
        let out = f.push(&resumed);

        assert!(!out.is_empty(), "resync never found a boundary");
        // The head fragment can confirm a boundary one sub-frame early, and
        // nothing in the bytes tells the two apart — a length read from inside
        // a frame can consume exactly to that frame's end. What must hold is
        // that the stream realigns: every frame after the first is whole.
        for d in out.iter().skip(1) {
            assert_eq!(d.body, frame[1..], "stream did not realign");
        }
    }

    /// A resync with too little data to confirm a boundary waits rather than
    /// guessing.
    #[test]
    fn resync_waits_until_a_boundary_is_confirmed() {
        let frame = crate::testdata::kdh_frame();
        let mut f = Framer::new();
        f.push(&frame.repeat(4));
        f.resync();

        assert!(f.push(&frame[3..10]).is_empty(), "not enough to confirm");
        assert!(
            !f.push(&frame.repeat(4)).is_empty(),
            "confirmed once the run arrives"
        );
    }

    #[test]
    fn handles_split_across_pushes() {
        let mut f = Framer::new();
        // feed byte-by-byte; frames should still emerge complete
        let mut total = 0;
        for b in &stream(4) {
            total += f.push(&[*b]).len();
        }
        assert_eq!(total, 4);
    }
}

/// Try each candidate layout; pick the one parsing the most consecutive Frames.
fn detect(buf: &[u8]) -> Option<Layout> {
    let mut best: Option<(usize, Layout)> = None;
    for &layout in CANDIDATES {
        let mut off = 0usize;
        let mut ok = 0usize;
        for _ in 0..12 {
            let slice = &buf[off..];
            match read_one(slice, layout) {
                Some((consumed, body)) => {
                    // body must be a substantial, fully-consumable protobuf
                    // message — not a stray `0A 00`. Works for both the game
                    // `Frame` and the connection-server Any envelope.
                    if body.len() >= 6 && crate::pb::looks_like_message(&body) {
                        ok += 1;
                        off += consumed;
                    } else {
                        break;
                    }
                }
                None => break,
            }
        }
        if ok >= 3 && best.map(|(b, _)| ok > b).unwrap_or(true) {
            best = Some((ok, layout));
        }
    }
    best.map(|(_, l)| l)
}

/// Count consecutive frames readable from `off`, up to `CONFIRM`.
fn frames_from(buf: &[u8], layout: Layout, mut off: usize) -> usize {
    let mut ok = 0;
    while ok < CONFIRM {
        match read_one(&buf[off..], layout) {
            Some((consumed, body)) if body.len() >= 6 && crate::pb::looks_like_message(&body) => {
                ok += 1;
                off += consumed;
            }
            _ => break,
        }
    }
    ok
}

/// First offset in `buf` that reads as a run of whole frames carrying a
/// message. Used after a lost segment, where the stream resumes at an
/// arbitrary byte.
///
/// A run of clean parses is not enough on its own. A length read from *inside*
/// a frame can consume exactly to that frame's end and parse as valid
/// protobuf, after which every following frame is aligned again — so the
/// false boundary confirms just as well as the true one, and comes first.
/// Requiring the frame at the offset to actually carry an `Any` rejects it:
/// resynchronising a sub-frame early would hand a truncated message to the
/// interpreters, and a wrong decode is worse than a missed one.
fn find_boundary(buf: &[u8], layout: Layout) -> Option<usize> {
    (0..buf.len())
        .find(|&off| frames_from(buf, layout, off) >= CONFIRM && carries_message(buf, layout, off))
}

/// Does the frame at `off` hold an `Any`? That is what the interpreters read,
/// and what a frame boundary landing mid-frame will not produce.
fn carries_message(buf: &[u8], layout: Layout, off: usize) -> bool {
    let Some((_, body)) = read_one(&buf[off..], layout) else {
        return false;
    };
    let mut anys = Vec::new();
    crate::dump::collect_any(&body, &mut anys);
    !anys.is_empty()
}

#[cfg(test)]
mod midstream_tests {
    use super::*;

    /// Starting the sniffer while the game is already connected: the first
    /// bytes captured are the tail of a frame whose head was never seen. Every
    /// later push keeps that prefix, so a detector that only ever tries offset
    /// 0 never locks — the flow stays dark for the life of the process and
    /// only a restart, landing by luck on a boundary, brings it back.
    #[test]
    fn detection_locks_when_the_capture_starts_mid_frame() {
        let frame = crate::testdata::kdh_frame();
        let mut f = Framer::new();

        let mut out = f.push(&frame[3..]); // tail of a frame never seen whole
        for _ in 0..40 {
            out.extend(f.push(&frame));
        }

        assert!(f.locked().is_some(), "never locked on a mid-frame start");
        assert!(!out.is_empty(), "locked but decoded nothing");
        for d in out.iter().skip(1) {
            assert_eq!(d.body, frame[1..], "decoded a frame that is not whole");
        }
    }

    /// The aligned case must still lock at offset 0 and lose nothing.
    #[test]
    fn detection_still_locks_at_offset_zero_when_aligned() {
        let frame = crate::testdata::kdh_frame();
        let mut f = Framer::new();

        let out = f.push(&frame.repeat(4));
        assert_eq!(out.len(), 4, "aligned start must decode every frame");
        assert_eq!(out[0].body, frame[1..]);
    }
}

/// Where the framing starts, not just which layout it uses.
///
/// Offset 0 is the aligned case and by far the common one, so it keeps the
/// original bar. A capture started while the game was already connected has no
/// such luck: its first bytes are the tail of a frame it never saw the head
/// of, and every later push keeps that same prefix, so testing offset 0 alone
/// never locks and the flow stays dark until the sniffer is restarted. Sliding
/// is a guess, so a slid offset has to clear the stricter bar `find_boundary`
/// uses — a run of whole frames, the first of which carries a message.
fn detect_at(buf: &[u8]) -> Option<(usize, Layout)> {
    if let Some(layout) = detect(buf) {
        return Some((0, layout));
    }
    let window = buf.len().min(MAX_DETECT_SCAN);
    (1..window).find_map(|off| {
        CANDIDATES
            .iter()
            .find(|&&layout| {
                frames_from(buf, layout, off) >= CONFIRM && carries_message(buf, layout, off)
            })
            .map(|&layout| (off, layout))
    })
}
