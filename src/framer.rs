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
    Layout { header: Header::Varint, includes_self: false, lead_skip: 0 },
    Layout { header: Header::Varint, includes_self: false, lead_skip: 1 },
    Layout { header: Header::U16Be, includes_self: false, lead_skip: 0 },
    Layout { header: Header::U16Be, includes_self: false, lead_skip: 1 },
    Layout { header: Header::U16Be, includes_self: true, lead_skip: 0 },
    Layout { header: Header::U32Be, includes_self: false, lead_skip: 0 },
    Layout { header: Header::U32Be, includes_self: false, lead_skip: 1 },
];

/// One deframed frame: the raw body bytes plus a decoded Frame if it parsed.
pub struct Deframed {
    pub body: Vec<u8>,
    pub frame: Option<Frame>,
}

pub struct Framer {
    buf: Vec<u8>,
    layout: Option<Layout>,
}

impl Framer {
    pub fn new() -> Self {
        Framer { buf: Vec::new(), layout: None }
    }

    pub fn locked(&self) -> Option<String> {
        self.layout.map(|l| format!("{:?} includes_self={} lead_skip={}", l.header, l.includes_self, l.lead_skip))
    }

    pub fn push(&mut self, data: &[u8]) -> Vec<Deframed> {
        self.buf.extend_from_slice(data);
        if self.layout.is_none() {
            self.layout = detect(&self.buf);
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
            Some((4, u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize))
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
    let payload_len = if layout.includes_self { raw_len.checked_sub(hlen)? } else { raw_len };
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
