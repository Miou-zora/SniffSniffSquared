//! Message -> understandable data.
//!
//! Per-message-type interpreters that turn a decoded protobuf body into named,
//! human-meaningful attributes.
//!
//! Interpreters key off the *semantic* message name (see `crate::messages`),
//! never the obfuscated wire key, and parse the body structurally with
//! `pb::Reader` rather than through the schema registry — the registry
//! describes an older build and cannot be trusted for field types.

use crate::messages;
use crate::pb::{Reader, WireType};
use crate::registry::{Registry, leaf};
use crate::schema;

/// Return a one-line understandable rendering for a known message, or None.
///
/// Dispatches on the *semantic* name, never the wire key — the keys rotate per
/// client build, so `crate::messages` owns that translation. To support a new
/// message: add its key to `messages::DEFAULTS`, then add an arm here.
pub fn interpret(key: &str, body: &[u8]) -> Option<String> {
    match messages::keymap().name(key)? {
        "price_list" => price_list(body).map(|p| p.to_string()),
        "crush_result" => crush_result(body).map(|c| c.to_string()),
        // Shown in --all output but deliberately not stored: the focus does
        // not change the yield, so it says nothing the crush row needs.
        "crush_slot_put" => crush_slot_change(body).map(|(delta, uid)| {
            if delta > 0 {
                format!("placed in breaker {{ uid={uid} x{delta} }}")
            } else {
                format!("taken out of breaker {{ uid={uid} x{} }}", -delta)
            }
        }),
        "crush_request" => Some(match crush_focus(body) {
            Some(effect) => format!("crush requested {{ focus effect {effect} }}"),
            None => "crush requested { no focus }".to_string(),
        }),
        "inventory" => inventory(body).map(|items| {
            let stacks = items.iter().filter(|i| i.quantity > 1).count();
            format!("inventory {{ {} slots, {stacks} stacked }}", items.len())
        }),
        "inventory_remove" => inventory_remove(body).map(|uid| format!("gone {{ uid={uid} }}")),
        "inventory_add" => inventory_add(body).map(|i| {
            format!(
                "picked up {{ uid={} item={} x{} }}",
                i.uid, i.item_id, i.quantity
            )
        }),
        "inventory_quantity" => inventory_quantity(body)
            .map(|(uid, quantity)| format!("stack {{ uid={uid} now x{quantity} }}")),
        _ => None,
    }
}

/// Whether we can interpret this wire key. Keep in sync with `interpret`.
pub fn is_known_key(key: &str) -> bool {
    matches!(
        messages::keymap().name(key),
        Some("price_list")
            | Some("crush_result")
            | Some("crush_request")
            | Some("crush_slot_put")
            | Some("inventory")
            | Some("inventory_remove")
            | Some("inventory_add")
            | Some("inventory_quantity")
    )
}

// ---- crush_result: breaking an item into runes (brisage) -------------------
//
// Identified by known-plaintext search across three real crushes, matching the
// rune counts and percentages read off the screen.
//
//   field 1  message
//       field 1  message   REPEATED, one per rune type
//           field 1  varint   rune item id
//           field 2  varint   how many were obtained
//       field 2  i32      float32 yield, 0.0-1.0  (0.76943 displayed as 77%)
//       field 3  varint   the crushed item's INSTANCE uid, not its type id
//       field 4  i32      float32, identical to field 2 in all observed
//                         samples; purpose unknown, so not stored
//
// The item *type* is not in this message. It arrives earlier as `item_detail`
// keyed by the same uid, which main.rs caches to fill it in.
//
// Focus (focalisation) is NOT here. It travels in the `crush_request` the client
// sends immediately before, as field 1 — see that section below. An earlier note
// claiming it was not sent per-crush was wrong: the requests do differ, but only
// in a field that is absent entirely when no focus is set, which is easy to miss.

#[derive(Debug, Clone, PartialEq)]
pub struct CrushResult {
    /// Instance uid of the crushed item. Join to `item_detail` for the type id.
    pub item_uid: u64,
    /// Yield as a fraction, 0.0-1.0. The client shows it as a percentage.
    pub yield_fraction: f32,
    /// (rune item id, quantity), one entry per rune type.
    pub runes: Vec<(u64, u64)>,
}

impl std::fmt::Display for CrushResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let runes: Vec<String> = self
            .runes
            .iter()
            .map(|(id, n)| format!("{id}x{n}"))
            .collect();
        write!(
            f,
            "crush {{ uid={} yield={:.1}% runes[{}] }}",
            self.item_uid,
            self.yield_fraction * 100.0,
            runes.join(" ")
        )
    }
}

/// Parse a crush (brisage) result straight off the wire.
pub fn crush_result(body: &[u8]) -> Option<CrushResult> {
    crush_result_with(body, schema::schema())
}

pub fn crush_result_with(body: &[u8], sch: &schema::Schema) -> Option<CrushResult> {
    let inner = sch.read("crush_result", body)?.msg("body")?.clone();
    let runes = inner
        .msgs("rune")
        .into_iter()
        .filter_map(|r| Some((r.uint("rune_id")?, r.uint("count").unwrap_or(0))))
        .filter(|(id, _)| *id != 0)
        .collect();
    // A crush that yielded nothing is still a crush, and its yield is the only
    // thing the table stores. Requiring runes threw away exactly the
    // observations worth having: a low coefficient on a small item rounds every
    // line below one rune, so the server sends the yield with an empty list --
    // 36.2% on an Amulette Verrehor, which is a coefficient reading that
    // nothing else can supply. What makes it a crush is the instance and the
    // yield, not the loot.
    let item_uid = inner.uint("uid").filter(|u| *u != 0)?;
    Some(CrushResult {
        item_uid,
        yield_fraction: inner.f32("yield")?,
        runes,
    })
}

// ---- crush_slot_put: item placed into the breaker --------------------------
//
// Sent when an item is dropped into the breaker's slot, and answered by an
// `item_detail` for the same uid. Confirmed by a placement with no crush after
// it: the item sat in the slot while the focus was changed and was never broken.
//
//   field 1  varint   SIGNED quantity delta: +1 adds one, -1 takes one back out
//   field 2  varint   instance uid of the item placed
//
// Field 1 is not always 1. A capture where an item was placed and then pulled
// back out carries `1=-1` (0xFFFF_FFFF_FFFF_FFFF as a two's-complement varint)
// for the same uid. Both directions are answered by an identical `item_detail`,
// so the sign is the only thing distinguishing a placement from a removal — read
// it, or the breaker's contents are tracked wrong and a removed item still looks
// like it is about to be crushed.

/// The instance uid of an item just put into the breaker, and `None` for a
/// removal — the caller only cares about what is going *in*.
pub fn crush_slot_put(body: &[u8]) -> Option<u64> {
    let (delta, uid) = crush_slot_change(body)?;
    (delta > 0).then_some(uid)
}

/// The raw `(quantity delta, uid)`, negative delta meaning the item left the
/// slot. Split out so the sign is testable independently of the filtering.
pub fn crush_slot_change(body: &[u8]) -> Option<(i64, u64)> {
    crush_slot_change_with(body, schema::schema())
}

pub fn crush_slot_change_with(body: &[u8], sch: &schema::Schema) -> Option<(i64, u64)> {
    let n = sch.read("crush_slot", body)?;
    let uid = n.uint("uid")?;
    // A missing delta is protobuf's default of 0, but every sample carries it
    // explicitly; treat its absence as "one, going in" rather than dropping the
    // message, since the uid is the part that matters.
    Some((n.uint("delta").map_or(1, |d| d as i64), uid))
}

// ---- crush_request: the client's "crush it" command ------------------------
//
// Sent immediately before every crush result. Field 1 carries the focus and is
// ABSENT when no focus is set — established across three crushes:
//
//   1=125 4=1 5=1   Baton d'Oubli, focus Vi
//         4=1 5=1   Arc Anum,      no focus      <- field 1 missing
//   1=125 4=1 5=2   Anneau Bsene,  focus Vi
//
// 125 is the rune's *effect id*, not its item id: DofusDB gives Rune Vi (1523)
// effectId 125, Rune Ine (1522) 126, Rune Age (1524) 119. One effect id covers
// several runes — 125 is Rune Vi, Rune Pa Vi and Rune Ra Vi alike.
//
// This is decoded for --all output but NOT stored. The focus does not affect
// the yield: the same item crushed with any focus, or none, returns the same
// percentage. Only the yield varies per crush, so only the yield is recorded.
//
// Fields 4 and 5 vary (1/1, 1/1, 1/2) and are not understood, so not stored.

/// The focus effect id from a crush request, or None when no focus was set.
pub fn crush_focus(body: &[u8]) -> Option<u64> {
    let mut r = Reader::new(body);
    let mut focus = None;
    while !r.eof() {
        let (field, wt) = r.tag()?;
        match (field, wt) {
            (1, WireType::Varint) => focus = Some(r.varint()?),
            (_, wt) => {
                if !r.skip(wt) {
                    return None;
                }
            }
        }
    }
    focus
}

// ---- item_detail: instance uid -> item type id -----------------------------
//
// Sent just before a crush result, describing the item about to be destroyed,
// and also whenever an item is put into the breaker's slot.
//
//   field 2  message
//       field 4  message
//           field 1  varint   instance uid
//           field 4  varint   item type id  (joins to DofusDB, and to prices)
//           field 5  message  REPEATED, one per stat line
//               field 8  varint  the rolled value
//               field 9  varint  effect id  (joins to runes.effect_id)
//
// The stat lines are the item's *rolled* values, which is the reason to keep
// them: DofusDB's template for an item gives the possible range, and for at
// least one captured item (779) the range does not even contain what the wire
// reported. The wire is the ground truth for what a specific item actually
// carried, and it is the only source for it — the instance is destroyed by the
// crush that follows.
//
// Note the field order inside a stat line is value *then* effect id, which
// reads backwards.

/// One item instance as the server described it.
pub struct ItemDetail {
    pub uid: u64,
    pub item_id: u64,
    /// How many are in this stack. Absent on the wire for a single copy, which
    /// is every piece of equipment, so it reads 1 there.
    pub quantity: u64,
    /// `(effect id, rolled value)`, in wire order.
    pub stats: Vec<(u64, i64)>,
}

/// The full description, stat lines included.
pub fn item_detail_full(body: &[u8]) -> Option<ItemDetail> {
    item_detail_full_with(body, schema::schema())
}

pub fn item_detail_full_with(body: &[u8], sch: &schema::Schema) -> Option<ItemDetail> {
    entries(&sch.read("item_detail", body)?).into_iter().next()
}

/// Every `item_entry` inside a message whose slots hold one each.
///
/// `item_detail`, `inventory` and `inventory_add` differ only in the field
/// numbers of that envelope, which is exactly what `schema.json` describes, so
/// all three read through here.
fn entries(node: &schema::Node) -> Vec<ItemDetail> {
    node.msgs("slot")
        .into_iter()
        .filter_map(|slot| item_entry(slot.msg("entry")?))
        .collect()
}

/// One item entry: uid, type, how many, and what it rolled.
fn item_entry(node: &schema::Node) -> Option<ItemDetail> {
    let uid = node.uint("uid")?;
    let item_id = node.uint("item_id")?;
    if uid == 0 || item_id == 0 {
        return None;
    }
    Some(ItemDetail {
        uid,
        item_id,
        // Absent for a single copy, which is how equipment always arrives.
        quantity: node.uint("quantity").unwrap_or(1),
        stats: node
            .msgs("stat")
            .into_iter()
            .filter_map(stat_line)
            .collect(),
    })
}

/// `(effect id, value)` from one stat line. Value comes first on the wire.
fn stat_line(node: &schema::Node) -> Option<(u64, i64)> {
    Some((node.uint("effect")?, node.uint("value")? as i64))
}

// ---- inventory: what is actually in the bags --------------------------------
//
// Identified without a known-plaintext read: every item put into the breaker
// over the whole capture (12 of 12, matched by instance uid) appears in the
// listing that preceded its placement, and none of them appear in the other
// container listing the server sends. That is the player's own inventory and
// nothing else.
//
//   field 1  message  REPEATED, one per slot
//       field 1  varint   slot / position
//       field 4  message  the item entry read by `item_entry` above
//
// It is a full snapshot, not a delta: the listing is the whole bag, so storing
// it means replacing what was there rather than adding to it. Removals arrive
// separately as `inventory_remove`, and a stack whose size changed is described
// again by `item_detail`.

/// Every item in an inventory listing. Empty is a real answer — an empty bag.
pub fn inventory(body: &[u8]) -> Option<Vec<ItemDetail>> {
    inventory_with(body, schema::schema())
}

pub fn inventory_with(body: &[u8], sch: &schema::Schema) -> Option<Vec<ItemDetail>> {
    Some(entries(&sch.read("inventory", body)?))
}

// ---- inventory_add: a new stack arrived -------------------------------------
//
// One entry in an envelope, read by `entries` like an `item_detail`. On the
// 2026-07-10 build it arrived in the *listing's* shape instead; the envelope is
// the same idea either way, and only `schema.json` says which numbers.
//
// Identified against a known purchase: nine Colonne Vertebrale bought one at a
// time produced one of these for the first -- uid 253751293, quantity 1, item
// 2323 -- and a quantity change for each of the eight after it. Re-confirmed on
// 2026-08-04 against one Palmano bought from the HDV: uid 2447309, item 8872.

/// The stack that just entered the bags.
pub fn inventory_add(body: &[u8]) -> Option<ItemDetail> {
    inventory_add_with(body, schema::schema())
}

pub fn inventory_add_with(body: &[u8], sch: &schema::Schema) -> Option<ItemDetail> {
    entries(&sch.read("inventory_add", body)?)
        .into_iter()
        .next()
}

// ---- inventory_quantity: an existing stack changed size ---------------------
//
// From nine purchases: 1->2, 2->3, ... 8->9, all on uid 253751293, ending at
// the nine that were bought. The previous quantity is on the wire and is
// deliberately not returned -- the new one is the answer, and a delta applied
// to a row that drifted would compound the drift instead of correcting it.

/// `(instance uid, the new stack size)`.
pub fn inventory_quantity(body: &[u8]) -> Option<(u64, u64)> {
    inventory_quantity_with(body, schema::schema())
}

pub fn inventory_quantity_with(body: &[u8], sch: &schema::Schema) -> Option<(u64, u64)> {
    let change = sch.read("inventory_quantity", body)?.msg("change")?.clone();
    let uid = change.uint("uid").filter(|u| *u != 0)?;
    Some((uid, change.uint("quantity").unwrap_or(0)))
}

// ---- inventory_remove: one instance is gone ---------------------------------
//
// Confirmed against every crush in the capture: the uid of the item placed in
// the breaker arrives here 1 to 11 seconds after the crush destroyed it.

/// The instance uid this message says has left the inventory.
pub fn inventory_remove(body: &[u8]) -> Option<u64> {
    inventory_remove_with(body, schema::schema())
}

pub fn inventory_remove_with(body: &[u8], sch: &schema::Schema) -> Option<u64> {
    sch.read("inventory_remove", body)?
        .uint("uid")
        .filter(|u| *u != 0)
}

// ---- price_list: marketplace price ladder ---------------------------------
//
// Identified by known-plaintext search: the prices shown in the HDV for one
// item turned up verbatim in this message (tools/findvalue.py). Parsed
// structurally rather than through the schema registry, which is keyed to an
// older build and cannot be trusted for this key.
//
//   field 1  varint            category (repeats as inner field 6)
//   field 2  message           REPEATED, one per offer
//       field 1  varint        item id
//       field 4  message       REPEATED, one per stat line — equipment only
//           field 8  varint    value this copy rolled
//           field 9  varint    effect id
//       field 5  packed        price ladder: x1, x10, x100, x1000
//       field 7  varint        listing id
//   field 3  varint            item id (repeats inner field 1)
//
// A ladder entry of 0 means that batch size is not on sale.
//
// **The message has two shapes and they mean different things.** Browsing a
// resource yields one offer whose ladder is a real x1/x10/x100/x1000 quote.
// Browsing equipment yields one offer *per copy on sale* — 34 in the message
// this was found in — each quoting a single price in the x1 slot and carrying
// the stats that copy actually rolled.
//
// This parser used to keep only the last offer, which for equipment meant an
// arbitrary seller's asking price recorded as if it were a market ladder, and
// every rolled stat discarded. The distinction the rest of the code needs is
// `stats.is_empty()`: a ladder describes a fungible stack, an offer with stats
// describes one specific copy.

/// One entry in a price message: a stack quote, or a single copy on sale.
#[derive(Debug, Clone, PartialEq)]
pub struct Offer {
    pub item_id: u64,
    /// x1, x10, x100, x1000. Equipment quotes only the first.
    pub ladder: Vec<u64>,
    pub listing_id: u64,
    /// `(effect id, value)` this copy rolled. Empty for a resource ladder.
    pub stats: Vec<(u64, i64)>,
}

impl Offer {
    /// The single-unit price, which is the whole price for one piece of gear.
    pub fn unit_price(&self) -> u64 {
        self.ladder.first().copied().unwrap_or(0)
    }

    /// Whether any batch beyond a single unit is quoted.
    fn batched(&self) -> bool {
        self.ladder.iter().skip(1).any(|&v| v > 0)
    }

    /// One specific copy of a piece of gear, rather than a quote for a stack.
    ///
    /// Stats alone do not settle it: a rune carries one stat line of its own —
    /// `Rune Vi` quotes `(125, 5)` — while still being a fungible stack sold by
    /// the thousand. What separates them is the ladder. A stack quotes the
    /// batch sizes it is available in; a single copy can only ever be sold
    /// once, so it quotes the x1 slot and nothing else.
    ///
    /// Both conditions are needed. Across the whole archive: 534 offers quote
    /// x1 with stats (gear), 129 quote a full ladder with one stat (runes), 49
    /// a ladder with none (resources), and 7 quote x1 alone with no stats —
    /// a resource with only singles on sale, which is a stack too.
    pub fn is_single_copy(&self) -> bool {
        !self.batched() && !self.stats.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PriceList {
    pub category: u64,
    pub offers: Vec<Offer>,
}

impl std::fmt::Display for PriceList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Some(first) = self.offers.first() else {
            return write!(f, "prices {{ empty }}");
        };
        if self.offers.len() > 1 || !first.stats.is_empty() {
            let cheapest = self
                .offers
                .iter()
                .map(|o| o.unit_price())
                .min()
                .unwrap_or(0);
            return write!(
                f,
                "listings {{ item={} category={} offers={} cheapest={} }}",
                first.item_id,
                self.category,
                self.offers.len(),
                cheapest
            );
        }
        let batches: Vec<String> = first
            .ladder
            .iter()
            .enumerate()
            .map(|(i, v)| format!("{}:{}", 10u64.pow(i as u32), v))
            .collect();
        write!(
            f,
            "prices {{ item={} category={} listing={} {} }}",
            first.item_id,
            self.category,
            first.listing_id,
            batches.join(" ")
        )
    }
}

/// Parse a price-list message straight off the wire.
pub fn price_list(body: &[u8]) -> Option<PriceList> {
    price_list_with(body, schema::schema())
}

pub fn price_list_with(body: &[u8], sch: &schema::Schema) -> Option<PriceList> {
    let node = sch.read("price_list", body)?;
    // Only some offers repeat the item id inline; the outer copy fills the rest.
    let outer_item = node.uint("item_id").unwrap_or(0);

    let offers: Vec<Offer> = node
        .msgs("offer")
        .into_iter()
        .map(|o| Offer {
            item_id: o.uint("item_id").unwrap_or(outer_item),
            ladder: o.list("ladder").unwrap_or_default(),
            listing_id: o.uint("listing_id").unwrap_or(0),
            stats: o.msgs("stat").into_iter().filter_map(stat_line).collect(),
        })
        .collect();

    // a price message with nothing priced in it is not one
    if offers.iter().all(|o| o.ladder.is_empty()) {
        return None;
    }
    let mut out = PriceList {
        category: node.uint("category").unwrap_or(0),
        offers,
    };
    out.offers.retain(|o| !o.ladder.is_empty());
    Some(out)
}

/// Schema-guided decoded values for a message key: every varint (in traversal
/// order) and every packed repeated-scalar array. Handlers receive this.
pub fn values(key: &str, body: &[u8], reg: &Registry) -> Collected {
    let mut c = Collected::default();
    collect(body, reg.resolve(key), reg, &mut c);
    c
}

// ---- generic schema-guided collection -------------------------------------

#[derive(Default, Debug, Clone)]
pub struct Collected {
    pub vars: Vec<u64>,
    pub packs: Vec<Vec<u64>>,
}

enum LenKind {
    PackedVarint,
    Message(String),
    /// Declaration contradicts the wire — decide from the bytes instead.
    Heuristic,
    Skip,
}

fn classify_len(csharp: Option<&str>) -> LenKind {
    let t = match csharp {
        Some(t) => t.trim(),
        None => return LenKind::Skip,
    };
    if let Some(inner) = t
        .strip_prefix("RepeatedField<")
        .and_then(|s| s.strip_suffix('>'))
    {
        return if is_scalar(inner) {
            LenKind::PackedVarint
        } else if is_len_scalar(inner) {
            LenKind::Skip // repeated string/bytes
        } else {
            LenKind::Message(inner.to_string())
        };
    }
    if t.starts_with("MapField<") || is_len_scalar(t) {
        return LenKind::Skip;
    }
    // A bare scalar can't be length-delimited: the schema is mis-joined here,
    // so ignore it rather than recurse into what is probably a string.
    if is_scalar(t) {
        return LenKind::Heuristic;
    }
    LenKind::Message(t.to_string())
}

fn is_scalar(t: &str) -> bool {
    matches!(
        t,
        "int" | "uint" | "long" | "ulong" | "bool" | "sbyte" | "byte" | "short" | "ushort" | "char"
    )
}

fn is_len_scalar(t: &str) -> bool {
    matches!(t, "string" | "ByteString")
}

fn collect(buf: &[u8], schema: Option<&crate::registry::Msg>, reg: &Registry, c: &mut Collected) {
    let mut r = Reader::new(buf);
    while !r.eof() {
        let (field, wt) = match r.tag() {
            Some(t) => t,
            None => return,
        };
        let csharp = schema
            .and_then(|s| s.fields.iter().find(|f| f.num == field))
            .map(|f| f.csharp.as_str());
        match wt {
            WireType::Varint => {
                c.vars.push(r.varint().unwrap_or(0));
            }
            WireType::Len => {
                let b = r.len_field().unwrap_or(&[]);
                match classify_len(csharp) {
                    // printable bytes under a packed declaration = mis-joined
                    // string field; feeding it to handlers as numbers is worse
                    // than dropping it
                    LenKind::PackedVarint if crate::pb::looks_like_text(b) => {}
                    LenKind::PackedVarint => c.packs.push(packed(b)),
                    LenKind::Message(tok) => {
                        collect(b, reg.resolve(leaf(&tok)), reg, c);
                    }
                    LenKind::Heuristic => {
                        if !b.is_empty() && crate::pb::looks_like_message(b) {
                            collect(b, None, reg, c);
                        }
                    }
                    LenKind::Skip => {}
                }
            }
            _ => {
                if !r.skip(wt) {
                    return;
                }
            }
        }
    }
}

fn packed(b: &[u8]) -> Vec<u64> {
    let mut r = Reader::new(b);
    let mut out = Vec::new();
    while !r.eof() {
        match r.varint() {
            Some(v) => out.push(v),
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    /// The 2026-07-10 build. Its fixtures below are real bytes off that wire and
    /// are the only surviving record of it, so they keep running -- against the
    /// same parsers, through the schema file that exists precisely so a rotation
    /// does not cost them.
    fn old() -> schema::Schema {
        let text = include_str!("../testdata/schema-2026-07-10.json");
        schema::Schema::parse(text, "testdata/schema-2026-07-10.json").expect("valid")
    }

    /// The current build, read from the shipped file rather than the process
    /// singleton so a test never depends on the working directory.
    fn now() -> schema::Schema {
        let text = include_str!("../schema.json");
        schema::Schema::parse(text, "schema.json").expect("valid")
    }
    use super::*;

    // Real captured price-list message, identified by known-plaintext search: the client
    // showed Carapace Verte at 1=75, 10=326, 100=6660, 1000=99999 and those
    // exact values appear here. Keep byte-exact.
    const PRICE_LIST: &[u8] = &[
        0x08, 0x6b, 0x12, 0x12, 0x08, 0xb1, 0x14, 0x2a, 0x08, 0x4b, 0xc6, 0x02, 0x84, 0x34, 0x9f,
        0x8d, 0x06, 0x30, 0x6b, 0x38, 0xc2, 0x4e, 0x18, 0xb1, 0x14,
    ];

    /// Real capture, packet #11319: the HDV listing panel for item 12502, two
    /// copies on sale at 9999 each with different rolls.
    const EQUIPMENT_LISTING: &[u8] = &[
        0x08, 0x0a, 0x12, 0x30, 0x08, 0xd6, 0x61, 0x22, 0x04, 0x40, 0x1f, 0x48, 0x7d, 0x22, 0x04,
        0x40, 0x10, 0x48, 0x7e, 0x22, 0x04, 0x40, 0x0b, 0x48, 0x7c, 0x22, 0x05, 0x40, 0x05, 0x48,
        0xb2, 0x01, 0x22, 0x05, 0x40, 0x02, 0x48, 0xf0, 0x05, 0x2a, 0x05, 0x8f, 0x4e, 0x00, 0x00,
        0x00, 0x30, 0x0a, 0x38, 0xf4, 0x9f, 0x02, 0x12, 0x30, 0x08, 0xd6, 0x61, 0x22, 0x04, 0x40,
        0x27, 0x48, 0x7d, 0x22, 0x04, 0x40, 0x15, 0x48, 0x7e, 0x22, 0x04, 0x40, 0x0f, 0x48, 0x7c,
        0x22, 0x05, 0x40, 0x05, 0x48, 0xb2, 0x01, 0x22, 0x05, 0x40, 0x02, 0x48, 0xf0, 0x05, 0x2a,
        0x05, 0x8f, 0x4e, 0x00, 0x00, 0x00, 0x30, 0x0a, 0x38, 0xf5, 0x9f, 0x02, 0x18, 0xd6, 0x61,
    ];

    // Real captured crushes. The client showed, for the Arc Anum: 32%, and
    // 2+1+10+2+11+23+2+20 runes across 8 types. Keep byte-exact.
    const CRUSH_ARC: &[u8] = &[
        0x0a, 0x47, 0x0a, 0x05, 0x08, 0xa1, 0x3a, 0x10, 0x02, 0x0a, 0x05, 0x08, 0xa4, 0x3a, 0x10,
        0x01, 0x0a, 0x05, 0x08, 0xf3, 0x0b, 0x10, 0x0a, 0x0a, 0x05, 0x08, 0x91, 0x5b, 0x10, 0x02,
        0x0a, 0x05, 0x08, 0x98, 0x3a, 0x10, 0x0b, 0x0a, 0x05, 0x08, 0xf2, 0x0b, 0x10, 0x17, 0x0a,
        0x05, 0x08, 0x8b, 0x5b, 0x10, 0x02, 0x0a, 0x05, 0x08, 0xf4, 0x0b, 0x10, 0x14, 0x15, 0x00,
        0xc9, 0xa4, 0x3e, 0x18, 0xd8, 0xe0, 0xa2, 0x3c, 0x25, 0x1a, 0xc9, 0xa4, 0x3e,
    ];

    // Anneau Bsene: 48%, 32 Rune Vi (id 1523), crushed with focus set.
    const CRUSH_RING: &[u8] = &[
        0x0a, 0x16, 0x0a, 0x05, 0x08, 0xf3, 0x0b, 0x10, 0x20, 0x15, 0x2a, 0xfd, 0xf4, 0x3e, 0x18,
        0x82, 0xef, 0xa3, 0x3c, 0x25, 0x45, 0xfd, 0xf4, 0x3e,
    ];

    // item_detail for the ring, mapping its instance uid to type id 7123.
    const ITEM_DETAIL_RING: &[u8] = &[
        0x12, 0x36, 0x08, 0x3f, 0x22, 0x32, 0x08, 0x82, 0xef, 0xa3, 0x3c, 0x18, 0x01, 0x20, 0xd3,
        0x37, 0x2a, 0x04, 0x40, 0x1c, 0x48, 0x7d, 0x2a, 0x04, 0x40, 0x02, 0x48, 0x70, 0x2a, 0x05,
        0x40, 0x02, 0x48, 0xb2, 0x01, 0x2a, 0x05, 0x40, 0x02, 0x48, 0xd5, 0x01, 0x2a, 0x05, 0x40,
        0x02, 0x48, 0xd3, 0x01, 0x2a, 0x05, 0x40, 0x01, 0x48, 0xb6, 0x01,
    ];

    // Real crush requests. Field 1 is the focus effect id and is absent when
    // no focus is set — the whole difference between these three.
    const REQ_FOCUS_VI: &[u8] = &[0x08, 0x7d, 0x20, 0x01, 0x28, 0x01]; // Baton d'Oubli
    const REQ_NO_FOCUS: &[u8] = &[0x20, 0x01, 0x28, 0x01]; // Arc Anum
    const REQ_FOCUS_VI2: &[u8] = &[0x08, 0x7d, 0x20, 0x01, 0x28, 0x02]; // Anneau Bsene

    // real placement: the item that was loaded into the breaker and never broken
    const SLOT_PUT: &[u8] = &[0x08, 0x01, 0x10, 0x95, 0xa9, 0xc3, 0x3c];

    // real removal: a Kwape de Glace put into the breaker and then pulled back
    // out before the crush. Field 1 is -1 as a two's-complement varint.
    const SLOT_REMOVE: &[u8] = &[
        0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x10, 0xfe, 0xca, 0xfb,
        0x3e,
    ];
    // the same uid going the other way, captured moments earlier
    const SLOT_ADD: &[u8] = &[0x08, 0x01, 0x10, 0xfe, 0xca, 0xfb, 0x3e];

    #[test]
    fn slot_put_reads_the_uid() {
        assert_eq!(crush_slot_put(SLOT_PUT), Some(126932117));
        // a crush request is not a placement
        assert_eq!(crush_slot_put(REQ_NO_FOCUS), None);
    }

    #[test]
    fn slot_removal_is_not_a_placement() {
        // same uid, opposite directions — only the sign of field 1 separates them
        assert_eq!(crush_slot_change(SLOT_ADD), Some((1, 132048254)));
        assert_eq!(crush_slot_change(SLOT_REMOVE), Some((-1, 132048254)));
        assert_eq!(crush_slot_put(SLOT_ADD), Some(132048254));
        assert_eq!(crush_slot_put(SLOT_REMOVE), None);
    }

    #[test]
    fn crush_focus_is_read_when_set() {
        // 125 is Rune Vi's effectId in DofusDB, not its item id (1523)
        assert_eq!(crush_focus(REQ_FOCUS_VI), Some(125));
        assert_eq!(crush_focus(REQ_FOCUS_VI2), Some(125));
    }

    #[test]
    fn crush_focus_is_none_when_unset() {
        assert_eq!(crush_focus(REQ_NO_FOCUS), None, "field 1 absent = no focus");
    }

    #[test]
    fn crush_decodes_many_rune_types() {
        let c = crush_result_with(CRUSH_ARC, &old()).expect("parses");
        assert_eq!(c.runes.len(), 8, "one entry per rune type");
        let total: u64 = c.runes.iter().map(|(_, n)| n).sum();
        assert_eq!(total, 71, "2+1+10+2+11+23+2+20 as shown in game");
        // Rune Vi was 10 of the 71
        assert!(c.runes.contains(&(1523, 10)), "{:?}", c.runes);
        assert!(
            (c.yield_fraction - 0.32185).abs() < 1e-4,
            "32%: {}",
            c.yield_fraction
        );
        assert_eq!(c.item_uid, 126398552);
    }

    #[test]
    fn crush_decodes_single_rune_type() {
        let c = crush_result_with(CRUSH_RING, &old()).expect("parses");
        assert_eq!(c.runes, vec![(1523, 32)], "32 Rune Vi");
        assert!(
            (c.yield_fraction - 0.47849).abs() < 1e-4,
            "48%: {}",
            c.yield_fraction
        );
        assert_eq!(c.item_uid, 126416770);
    }

    #[test]
    fn item_detail_maps_uid_to_type() {
        // the same uid the ring crush reports, resolving to Anneau Bsene
        let d = item_detail_full_with(ITEM_DETAIL_RING, &old()).expect("ring decodes");
        assert_eq!((d.uid, d.item_id), (126416770, 7123));
    }

    #[test]
    fn item_detail_reads_every_stat_line() {
        let d = item_detail_full_with(ITEM_DETAIL_RING, &old()).expect("ring decodes");
        assert_eq!((d.uid, d.item_id), (126416770, 7123));
        // Anneau Bsene as the wire described it: Vitalite 28, Dommage 2,
        // Soin 2, Re Per Feu 2, Re Per Eau 2, Invocation 1.
        assert_eq!(
            d.stats,
            vec![(125, 28), (112, 2), (178, 2), (213, 2), (211, 2), (182, 1)]
        );
    }

    #[test]
    fn item_detail_without_stats_still_resolves() {
        // truncating to the uid and type must not lose them: the crush that
        // follows needs the type and does not care about the stats
        let head: &[u8] = &[
            0x12, 0x0c, 0x08, 0x3f, 0x22, 0x08, 0x08, 0x82, 0xef, 0xa3, 0x3c, 0x20, 0xd3, 0x37,
        ];
        let d = item_detail_full_with(head, &old()).expect("head decodes");
        assert_eq!((d.uid, d.item_id), (126416770, 7123));
        assert!(d.stats.is_empty());
    }

    #[test]
    fn crush_rejects_unrelated_messages() {
        assert!(
            crush_result_with(PRICE_LIST, &old()).is_none(),
            "a price list is not a crush"
        );
        assert!(item_detail_full_with(PRICE_LIST, &old()).is_none());
    }

    /// A real inventory listing, the smallest one in the capture. Identified by
    /// the fact that every item ever put into the breaker appears in the
    /// listing that preceded its placement, matched by instance uid.
    ///
    /// Kept as a file rather than inline: it is 2.3 KB of real bytes, and
    /// trimming it to fit on the page would make it a fixture somebody wrote.
    const INVENTORY: &[u8] = include_bytes!("../testdata/inventory.bin");

    /// Real capture, packet #89909: the uid of an item that left the bags.
    const GONE: &[u8] = &[0x18, 0xdc, 0xb7, 0x97, 0x6e];

    #[test]
    fn inventory_reads_every_slot() {
        let items = inventory_with(INVENTORY, &old()).expect("parses");
        assert_eq!(items.len(), 45, "one entry per occupied slot");
        let first = &items[0];
        assert_eq!((first.uid, first.item_id), (247103788, 9174));
        assert_eq!(first.quantity, 1, "equipment is one copy");
        assert_eq!(items.iter().map(|i| i.quantity).sum::<u64>(), 267);
    }

    #[test]
    fn inventory_keeps_stack_sizes() {
        let items = inventory_with(INVENTORY, &old()).expect("parses");
        let stacked: Vec<_> = items.iter().filter(|i| i.quantity > 1).collect();
        assert_eq!(stacked.len(), 10, "the resources, as opposed to the gear");
        // 8 Moyenne pierre d'ame, the first stack in the listing.
        let stack = stacked[0];
        assert_eq!(
            (stack.uid, stack.item_id, stack.quantity),
            (247103796, 9687, 8)
        );
    }

    #[test]
    fn inventory_remove_reads_the_uid() {
        assert_eq!(inventory_remove_with(GONE, &old()), Some(231070684));
    }

    /// Real capture, packets #99201 and #99209: the first of nine Colonne
    /// Vertebrale bought one at a time, and the change that followed it.
    /// Item 2323 at uid 253751293, going 1 -> 2 on the second purchase.
    const PICKED_UP: &[u8] = &[
        0x0a, 0x14, 0x08, 0x3f, 0x22, 0x10, 0x08, 0xfd, 0xdf, 0xff, 0x78, 0x12, 0x04, 0x08, 0x01,
        0x10, 0x01, 0x18, 0x01, 0x20, 0x93, 0x12,
    ];
    const RESTACKED: &[u8] = &[
        0x12, 0x04, 0x08, 0x01, 0x10, 0x01, 0x22, 0x07, 0x08, 0x02, 0x10, 0xfd, 0xdf, 0xff, 0x78,
    ];

    #[test]
    fn inventory_add_reads_the_new_stack() {
        let item = inventory_add_with(PICKED_UP, &old()).expect("parses");
        assert_eq!(
            (item.uid, item.item_id, item.quantity),
            (253751293, 2323, 1)
        );
    }

    #[test]
    fn inventory_quantity_reads_the_new_size() {
        // The wire carries the old size too; the new one is what is stored, so
        // a row that drifted is corrected rather than having a delta applied.
        assert_eq!(
            inventory_quantity_with(RESTACKED, &old()),
            Some((253751293, 2))
        );
    }

    #[test]
    fn inventory_reads_nothing_out_of_another_message() {
        // A price list carries no item entry, so it reads as an empty bag --
        // which is exactly why main.rs refuses to apply an empty snapshot: an
        // empty listing and a listing that was never one look the same here.
        assert_eq!(inventory_with(PRICE_LIST, &old()).map(|i| i.len()), Some(0));
        // `inventory_remove` is a bare uid, and a bare uid is a shape half the
        // protocol shares -- a price list's field 3 reads as one. Nothing tells
        // these two apart structurally; the wire key does, which is why this
        // parser is only ever handed a message that key already matched.
        assert_eq!(
            inventory_remove_with(PRICE_LIST, &old()),
            Some(2609),
            "item id, not a uid"
        );
    }

    #[test]
    fn item_detail_defaults_to_one_copy() {
        let d = item_detail_full_with(ITEM_DETAIL_RING, &old()).expect("ring decodes");
        assert_eq!(d.quantity, 1, "no quantity on the wire means a single copy");
    }

    #[test]
    fn price_list_decodes_the_ladder() {
        let p = price_list_with(PRICE_LIST, &old()).expect("parses");
        assert_eq!(
            p.offers.len(),
            1,
            "a resource quote is one stack, not listings"
        );
        let o = &p.offers[0];
        assert_eq!(o.ladder, vec![75, 326, 6660, 99999], "prices shown in game");
        assert_eq!(o.item_id, 2609);
        assert_eq!(p.category, 107);
        assert_eq!(o.listing_id, 10050);
        assert!(
            o.stats.is_empty(),
            "a stack of resources has no rolled stats"
        );
        assert!(is_known_key(messages::keymap().key("price_list").unwrap()));
    }

    /// A rune quotes a full ladder *and* carries one stat line — its own bonus.
    ///
    /// Classifying on "has stats" therefore sent every rune to `offers` and
    /// stopped its ladder reaching `prices`, which is where rune values and
    /// craft costs are read from. The ladder is what separates them: a stack is
    /// sold by the batch, a single copy only ever once.
    #[test]
    fn a_rune_is_a_stack_even_though_it_has_a_stat() {
        let rune = Offer {
            item_id: 1523,
            ladder: vec![183, 1830, 17999, 181999],
            listing_id: 5720,
            stats: vec![(125, 5)],
        };
        assert!(!rune.is_single_copy(), "Rune Vi is sold by the thousand");

        let gear = Offer {
            item_id: 12502,
            ladder: vec![9999, 0, 0, 0],
            listing_id: 36852,
            stats: vec![(125, 31), (126, 16)],
        };
        assert!(gear.is_single_copy(), "gear quotes x1 and nothing else");

        // A resource with only singles left on sale: x1 alone, but no stats.
        let singles = Offer {
            item_id: 15378,
            ladder: vec![68800, 0, 0, 0],
            listing_id: 1,
            stats: Vec::new(),
        };
        assert!(!singles.is_single_copy(), "still a stack, just a short one");
    }

    /// Real capture, packet #60384: an Amulette Verrehor crushed at 36.2%
    /// yielding no runes at all, because every line rounded below one.
    ///
    /// This parsed as "not a crush" until the rune list stopped being required,
    /// which lost the only reading of that item's coefficient there will ever
    /// be — the instance is gone.
    const CRUSH_NO_RUNES: &[u8] = &[
        0x0a, 0x0f, 0x15, 0x32, 0x58, 0xb9, 0x3e, 0x18, 0xdc, 0xc1, 0x82, 0x5b, 0x25, 0x48, 0x58,
        0xb9, 0x3e,
    ];

    #[test]
    fn a_crush_that_yielded_nothing_is_still_a_crush() {
        let c = crush_result_with(CRUSH_NO_RUNES, &old()).expect("parses");
        assert_eq!(c.item_uid, 190882012);
        assert!(c.runes.is_empty(), "nothing rounded up to a whole rune");
        assert!(
            (c.yield_fraction - 0.362).abs() < 0.001,
            "36.2%, which is what the client showed: {}",
            c.yield_fraction
        );
    }

    /// Equipment browsing, packet #11319: two copies of item 12502 on sale.
    ///
    /// The parser used to keep the last offer only, so this message became one
    /// row claiming a ladder — an arbitrary seller's price recorded as the
    /// market's, with both sets of rolled stats thrown away.
    #[test]
    fn price_list_keeps_every_offer_with_its_rolled_stats() {
        let p = price_list_with(EQUIPMENT_LISTING, &old()).expect("parses");
        assert_eq!(p.category, 10);
        assert_eq!(p.offers.len(), 2, "one offer per copy on sale");

        let first = &p.offers[0];
        assert_eq!(first.item_id, 12502);
        assert_eq!(first.listing_id, 36852);
        assert_eq!(
            first.unit_price(),
            9999,
            "gear quotes one price, in the x1 slot"
        );
        assert_eq!(
            first.stats,
            vec![(125, 31), (126, 16), (124, 11), (178, 5), (752, 2)],
            "what this copy rolled, effect id then value"
        );

        let second = &p.offers[1];
        assert_eq!(second.listing_id, 36853);
        assert_eq!(
            second.stats,
            vec![(125, 39), (126, 21), (124, 15), (178, 5), (752, 2)],
            "the same item type rolls differently per copy — the whole point"
        );
    }

    #[test]
    fn price_list_renders_batches() {
        let s = price_list_with(PRICE_LIST, &old()).unwrap().to_string();
        assert!(s.contains("1:75"), "{s}");
        assert!(s.contains("1000:99999"), "{s}");
        assert!(s.contains("item=2609"), "{s}");
    }

    #[test]
    fn price_list_rejects_messages_without_a_ladder() {
        // a short `kea` ack carrying only ids — real capture, no prices in it
        assert!(price_list_with(&[0x08, 0x77, 0x18, 0x8a, 0x0d], &old()).is_none());
    }

    // ---- 2026-08-04 build ---------------------------------------------------
    //
    // The client update that rotated every wire key moved field numbers too.
    // These are real bytes captured while doing one known thing each, and they
    // run through `now()` -- the shapes shipped in `schema.json` -- while
    // the fixtures above still run through `old()`. Same parsers, two builds.

    /// One rune's ladder. A rune quotes a full x1/x10/x100/x1000 *and* carries
    /// its own stat line, which is why it is here rather than a plain resource.
    const RUNE_LADDER: &[u8] = &[
        0x08, 0x4e, 0x10, 0x89, 0x3a, 0x1a, 0x1a, 0x08, 0xec, 0x9f, 0x01, 0x22, 0x04, 0x20, 0x01,
        0x58, 0x73, 0x28, 0x89, 0x3a, 0x32, 0x09, 0xf4, 0x11, 0xa4, 0xb7, 0x01, 0xa6, 0xa9, 0x0e,
        0x00, 0x40, 0x4e,
    ];

    /// Five Palmano on sale, one offer each, every one with its rolled stats —
    /// the equipment shape, where the ladder quotes a single asking price.
    const PALMANO_ON_SALE: &[u8] = &[
        0x08, 0x09, 0x10, 0xa8, 0x45, 0x1a, 0x24, 0x08, 0xf7, 0xdc, 0x01, 0x22, 0x04, 0x20, 0x37,
        0x58, 0x7d, 0x22, 0x04, 0x20, 0x14, 0x58, 0x77, 0x22, 0x05, 0x20, 0x01, 0x58, 0xb6, 0x01,
        0x28, 0xa8, 0x45, 0x32, 0x06, 0xb0, 0xea, 0x01, 0x00, 0x00, 0x00, 0x40, 0x09, 0x1a, 0x17,
        0x08, 0xf8, 0xdc, 0x01, 0x22, 0x04, 0x20, 0x14, 0x58, 0x77, 0x28, 0xa8, 0x45, 0x32, 0x06,
        0xb7, 0x94, 0x01, 0x00, 0x00, 0x00, 0x40, 0x09, 0x1a, 0x1e, 0x08, 0xf9, 0xdc, 0x01, 0x22,
        0x05, 0x20, 0x2d, 0x58, 0xae, 0x01, 0x22, 0x04, 0x20, 0x26, 0x58, 0x77, 0x28, 0xa8, 0x45,
        0x32, 0x06, 0xb8, 0x94, 0x01, 0x00, 0x00, 0x00, 0x40, 0x09, 0x1a, 0x25, 0x08, 0xfa, 0xdc,
        0x01, 0x22, 0x05, 0x20, 0x70, 0x58, 0xae, 0x01, 0x22, 0x04, 0x20, 0x10, 0x58, 0x77, 0x22,
        0x05, 0x20, 0x01, 0x58, 0xb6, 0x01, 0x28, 0xa8, 0x45, 0x32, 0x06, 0xe8, 0x84, 0x01, 0x00,
        0x00, 0x00, 0x40, 0x09, 0x1a, 0x2b, 0x08, 0xfb, 0xdc, 0x01, 0x22, 0x05, 0x20, 0x73, 0x58,
        0xae, 0x01, 0x22, 0x04, 0x20, 0x64, 0x58, 0x7d, 0x22, 0x04, 0x20, 0x12, 0x58, 0x77, 0x22,
        0x05, 0x20, 0x01, 0x58, 0xb6, 0x01, 0x28, 0xa8, 0x45, 0x32, 0x06, 0xe8, 0xfb, 0x03, 0x00,
        0x00, 0x00, 0x40, 0x09,
    ];

    /// The Palmano that was bought, described by the server: uid 2447309.
    const PALMANO_DETAIL: &[u8] = &[
        0x0a, 0x22, 0x08, 0x3f, 0x2a, 0x1e, 0x08, 0xa8, 0x45, 0x12, 0x05, 0x20, 0x70, 0x58, 0xae,
        0x01, 0x12, 0x04, 0x20, 0x10, 0x58, 0x77, 0x12, 0x05, 0x20, 0x01, 0x58, 0xb6, 0x01, 0x18,
        0x01, 0x20, 0xcd, 0xaf, 0x95, 0x01,
    ];

    /// The same uid arriving in the bag, one purchase.
    const PALMANO_ARRIVED: &[u8] = &[
        0x1a, 0x28, 0x08, 0x3f, 0x2a, 0x24, 0x08, 0xa8, 0x45, 0x12, 0x05, 0x20, 0x70, 0x58, 0xae,
        0x01, 0x12, 0x04, 0x20, 0x10, 0x58, 0x77, 0x12, 0x05, 0x20, 0x01, 0x58, 0xb6, 0x01, 0x18,
        0x01, 0x20, 0xcd, 0xaf, 0x95, 0x01, 0x2a, 0x04, 0x08, 0x01, 0x10, 0x01,
    ];

    const PALMANO_INTO_BREAKER: &[u8] = &[0x08, 0x01, 0x10, 0xcd, 0xaf, 0x95, 0x01];

    /// What it broke into: Ini x20, Invo x2, Age x28 — Palmano's own three lines.
    const PALMANO_CRUSHED: &[u8] = &[
        0x0a, 0x24, 0x08, 0xcd, 0xaf, 0x95, 0x01, 0x1a, 0x05, 0x08, 0x98, 0x3a, 0x10, 0x14, 0x1a,
        0x05, 0x08, 0x92, 0x3a, 0x10, 0x02, 0x1a, 0x05, 0x08, 0xf4, 0x0b, 0x10, 0x1c, 0x25, 0x8f,
        0x1a, 0x14, 0x40, 0x2d, 0x90, 0x1a, 0x14, 0x40,
    ];

    const PALMANO_GONE: &[u8] = &[0x08, 0xcd, 0xaf, 0x95, 0x01];

    /// A rune stack resized by the crush that had just produced runes.
    const RUNES_RESTACKED: &[u8] = &[0x1a, 0x06, 0x10, 0x84, 0xbd, 0x6f, 0x18, 0x20];

    /// The bag, 3.1 KB, captured immediately after the Palmano purchase — which
    /// is how it was identified: this is the one listing carrying that uid.
    const BAG: &[u8] = include_bytes!("../testdata/inventory-2026-08.bin");

    #[test]
    fn rune_ladder_decodes_on_the_current_build() {
        let p = price_list_with(RUNE_LADDER, &now()).expect("parses");
        assert_eq!(p.category, 78);
        assert_eq!(p.offers.len(), 1);
        let o = &p.offers[0];
        assert_eq!(o.item_id, 7433);
        assert_eq!(o.listing_id, 20460);
        assert_eq!(
            o.ladder,
            vec![2292, 23460, 234662, 0],
            "0 = nobody selling x1000"
        );
        assert_eq!(o.stats, vec![(115, 1)], "a rune carries its own bonus");
    }

    /// Equipment quotes one offer per copy on sale, each with what it rolled.
    #[test]
    fn equipment_listing_keeps_every_copy_on_the_current_build() {
        let p = price_list_with(PALMANO_ON_SALE, &now()).expect("parses");
        assert_eq!(p.category, 9);
        assert_eq!(p.offers.len(), 5);
        assert!(p.offers.iter().all(|o| o.item_id == 8872), "all Palmano");
        let first = &p.offers[0];
        assert_eq!(first.listing_id, 28279);
        assert_eq!(
            first.ladder,
            vec![30000, 0, 0, 0],
            "one asking price, not a ladder"
        );
        // 125 Vitalite, 119 Agilite, 182 Invocation
        assert_eq!(first.stats, vec![(125, 55), (119, 20), (182, 1)]);
        assert_eq!(p.offers[1].stats.len(), 1, "a copy that rolled one line");
    }

    /// Every value here is checkable against DofusDB's template for item 8872:
    /// 174 Initiative 101-150, 119 Agilite 16-20, 182 Invocation 1-1.
    #[test]
    fn item_detail_decodes_on_the_current_build() {
        let d = item_detail_full_with(PALMANO_DETAIL, &now()).expect("parses");
        assert_eq!(d.uid, 2447309);
        assert_eq!(d.item_id, 8872);
        assert_eq!(d.quantity, 1);
        assert_eq!(d.stats, vec![(174, 112), (119, 16), (182, 1)]);
    }

    #[test]
    fn inventory_add_decodes_on_the_current_build() {
        let d = inventory_add_with(PALMANO_ARRIVED, &now()).expect("parses");
        assert_eq!((d.uid, d.item_id, d.quantity), (2447309, 8872, 1));
    }

    /// The one field number the 2026-08-04 rotation left alone.
    #[test]
    fn slot_put_is_unchanged_between_builds() {
        assert_eq!(
            crush_slot_change_with(PALMANO_INTO_BREAKER, &now()),
            Some((1, 2447309))
        );
        assert_eq!(
            crush_slot_change_with(PALMANO_INTO_BREAKER, &old()),
            Some((1, 2447309))
        );
    }

    #[test]
    fn crush_decodes_on_the_current_build() {
        let c = crush_result_with(PALMANO_CRUSHED, &now()).expect("parses");
        assert_eq!(
            c.item_uid, 2447309,
            "the instance that went into the breaker"
        );
        // 7448 Ini, 7442 Invo, 1524 Age — the three lines Palmano rolls
        assert_eq!(c.runes, vec![(7448, 20), (7442, 2), (1524, 28)]);
        assert!(
            (c.yield_fraction - 2.3141210).abs() < 1e-6,
            "{}",
            c.yield_fraction
        );
    }

    #[test]
    fn inventory_remove_decodes_on_the_current_build() {
        assert_eq!(inventory_remove_with(PALMANO_GONE, &now()), Some(2447309));
    }

    #[test]
    fn inventory_quantity_decodes_on_the_current_build() {
        assert_eq!(
            inventory_quantity_with(RUNES_RESTACKED, &now()),
            Some((1826436, 32))
        );
    }

    /// The purchased uid is in this listing, which is what says it is the bag
    /// and not one of the other containers the server describes.
    #[test]
    fn inventory_decodes_on_the_current_build() {
        let items = inventory_with(BAG, &now()).expect("parses");
        assert!(items.len() > 20, "a real bag, {} slots", items.len());
        let bought = items
            .iter()
            .find(|i| i.uid == 2447309)
            .expect("the Palmano just bought");
        assert_eq!(bought.item_id, 8872);
        assert!(
            items.iter().any(|i| i.quantity > 1),
            "stacks keep their size"
        );
    }

    /// A body from the other build must not half-parse into something plausible
    /// — that is the failure the layout table exists to make impossible.
    #[test]
    fn a_body_from_the_other_build_is_rejected() {
        assert!(
            price_list_with(RUNE_LADDER, &old()).is_none(),
            "new bytes, old numbers"
        );
        assert!(item_detail_full_with(PALMANO_DETAIL, &old()).is_none());
        assert!(crush_result_with(PALMANO_CRUSHED, &old()).is_none());
        assert!(
            price_list_with(PRICE_LIST, &now()).is_none(),
            "old bytes, new numbers"
        );
    }
}
