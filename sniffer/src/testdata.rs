//! Real captured bytes shared by the reassembly and deframing tests.
//!
//! Hand-built frames were tried first and quietly misled: a synthetic `Frame`
//! carrying no `Any` cannot exercise a resynchronisation, because finding a
//! frame boundary is precisely a question about what a real message looks
//! like.

/// The `kdh` price-list frame from `docs/observations.md`, length prefix
/// included — the same bytes `tools/replay.py` sends over loopback.
pub const KDH_FRAME_HEX: &str = concat!(
    "350a330a310a13747970652e616e6b616d612e636f6d2f6b6468121a0a1308e13f1068",
    "22088a03c50fa4c3010028ab9d0118e13f2068"
);

/// `KDH_FRAME_HEX` as bytes. 54 bytes: a one-byte `0x35` length prefix and a
/// 53-byte body.
pub fn kdh_frame() -> Vec<u8> {
    (0..KDH_FRAME_HEX.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&KDH_FRAME_HEX[i..i + 2], 16).expect("valid hex"))
        .collect()
}
