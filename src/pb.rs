//! Minimal protobuf wire reader (no schema needed). Enough to parse the Frame
//! envelope and to walk arbitrary message bodies for a readable dump.

#[derive(Debug)]
pub struct Reader<'a> {
    pub buf: &'a [u8],
    pub pos: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireType {
    Varint,
    I64,
    Len,
    I32,
    Unknown(u8),
}

impl From<u8> for WireType {
    fn from(v: u8) -> Self {
        match v {
            0 => WireType::Varint,
            1 => WireType::I64,
            2 => WireType::Len,
            5 => WireType::I32,
            o => WireType::Unknown(o),
        }
    }
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    pub fn eof(&self) -> bool {
        self.pos >= self.buf.len()
    }

    /// Read a base-128 varint. Returns None on truncation/overflow.
    pub fn varint(&mut self) -> Option<u64> {
        let mut result: u64 = 0;
        let mut shift = 0u32;
        loop {
            if self.pos >= self.buf.len() || shift >= 64 {
                return None;
            }
            let byte = self.buf[self.pos];
            self.pos += 1;
            result |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                return Some(result);
            }
            shift += 7;
        }
    }

    /// Read a tag; returns (field_number, wire_type).
    pub fn tag(&mut self) -> Option<(u32, WireType)> {
        let key = self.varint()?;
        let field = (key >> 3) as u32;
        if field == 0 {
            return None;
        }
        Some((field, WireType::from((key & 0x7) as u8)))
    }

    pub fn read_bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.pos + n > self.buf.len() {
            return None;
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Some(s)
    }

    /// Read a length-delimited field's bytes.
    pub fn len_field(&mut self) -> Option<&'a [u8]> {
        let n = self.varint()? as usize;
        self.read_bytes(n)
    }

    /// Skip a field of the given wire type. Returns false if it can't.
    pub fn skip(&mut self, wt: WireType) -> bool {
        match wt {
            WireType::Varint => self.varint().is_some(),
            WireType::I64 => self.read_bytes(8).is_some(),
            WireType::I32 => self.read_bytes(4).is_some(),
            WireType::Len => self.len_field().is_some(),
            WireType::Unknown(_) => false,
        }
    }
}

/// Heuristic: printable text of some length. Used to spot a schema declaring a
/// packed numeric field where the wire really carries a string — both are
/// length-delimited, so the wire type alone can't tell them apart.
pub fn looks_like_text(b: &[u8]) -> bool {
    if b.len() < 4 {
        return false;
    }
    match std::str::from_utf8(b) {
        Ok(s) => s.chars().all(|c| !c.is_control() || c == '\n' || c == '\t'),
        Err(_) => false,
    }
}

/// Heuristic: does `buf` look like a valid, fully-consumable protobuf message?
/// Used by the framer to validate candidate frame boundaries.
pub fn looks_like_message(buf: &[u8]) -> bool {
    if buf.is_empty() {
        return false;
    }
    let mut r = Reader::new(buf);
    while !r.eof() {
        match r.tag() {
            Some((_, wt)) => {
                if !r.skip(wt) {
                    return false;
                }
            }
            None => return false,
        }
    }
    true
}
