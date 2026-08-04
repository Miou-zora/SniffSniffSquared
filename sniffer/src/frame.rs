//! Dofus 3 `Frame` envelope (Ankama.SpinConnection).
//!
//! ```proto
//! message Frame {
//!   oneof content { Request request=1; Response response=2; Payload event=3; }
//!   message Request  { int32 correlation_id=1; Payload payload=2; }
//!   message Response { int32 correlation_id=1; int32 status=2; Payload payload=3; }
//!   message Payload  { int32 id=1; bytes data=2; }   // id = message type hash, data = body
//! }
//! ```

use crate::pb::{Reader, WireType};

#[derive(Debug, Default)]
pub struct Payload {
    pub id: i64,
    pub data: Vec<u8>,
}

/// Nothing reads `correlation_id` or `status`: messages are keyed by the `Any`
/// type URL, not by anything in the envelope (see CLAUDE.md). They are parsed
/// and kept because they are part of the frame format and show up in `--raw`
/// output, and dropping them would make the struct stop describing the wire.
#[derive(Debug)]
#[allow(dead_code)]
pub enum Frame {
    Request {
        correlation_id: i64,
        payload: Payload,
    },
    Response {
        correlation_id: i64,
        status: i64,
        payload: Payload,
    },
    Event(Payload),
}

impl Payload {
    fn parse(buf: &[u8]) -> Option<Payload> {
        let mut p = Payload::default();
        let mut r = Reader::new(buf);
        while !r.eof() {
            let (field, wt) = r.tag()?;
            match (field, wt) {
                (1, WireType::Varint) => p.id = r.varint()? as i64,
                (2, WireType::Len) => p.data = r.len_field()?.to_vec(),
                (_, wt) => {
                    if !r.skip(wt) {
                        return None;
                    }
                }
            }
        }
        Some(p)
    }
}

impl Frame {
    /// Parse one Frame from a complete frame payload (protobuf bytes).
    pub fn parse(buf: &[u8]) -> Option<Frame> {
        let mut r = Reader::new(buf);
        let (field, wt) = r.tag()?;
        if wt != WireType::Len {
            return None;
        }
        let inner = r.len_field()?;
        match field {
            1 => {
                let (cid, pl) = parse_request(inner)?;
                Some(Frame::Request {
                    correlation_id: cid,
                    payload: pl,
                })
            }
            2 => {
                let (cid, st, pl) = parse_response(inner)?;
                Some(Frame::Response {
                    correlation_id: cid,
                    status: st,
                    payload: pl,
                })
            }
            3 => Some(Frame::Event(Payload::parse(inner)?)),
            _ => None,
        }
    }

    pub fn payload(&self) -> &Payload {
        match self {
            Frame::Request { payload, .. } => payload,
            Frame::Response { payload, .. } => payload,
            Frame::Event(p) => p,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Frame::Request { .. } => "REQ",
            Frame::Response { .. } => "RSP",
            Frame::Event(_) => "EVT",
        }
    }
}

fn parse_request(buf: &[u8]) -> Option<(i64, Payload)> {
    let mut cid = 0i64;
    let mut pl = Payload::default();
    let mut r = Reader::new(buf);
    while !r.eof() {
        let (field, wt) = r.tag()?;
        match (field, wt) {
            (1, WireType::Varint) => cid = r.varint()? as i64,
            (2, WireType::Len) => pl = Payload::parse(r.len_field()?)?,
            (_, wt) => {
                if !r.skip(wt) {
                    return None;
                }
            }
        }
    }
    Some((cid, pl))
}

fn parse_response(buf: &[u8]) -> Option<(i64, i64, Payload)> {
    let mut cid = 0i64;
    let mut status = 0i64;
    let mut pl = Payload::default();
    let mut r = Reader::new(buf);
    while !r.eof() {
        let (field, wt) = r.tag()?;
        match (field, wt) {
            (1, WireType::Varint) => cid = r.varint()? as i64,
            (2, WireType::Varint) => status = r.varint()? as i64,
            (3, WireType::Len) => pl = Payload::parse(r.len_field()?)?,
            (_, wt) => {
                if !r.skip(wt) {
                    return None;
                }
            }
        }
    }
    Some((cid, status, pl))
}
