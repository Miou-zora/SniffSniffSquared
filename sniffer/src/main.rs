//! Dofus 3 (Unity / Ankama.SpinConnection) packet sniffer.
//!
//! Pipeline: pcap -> TCP reassembly -> adaptive deframing -> `Frame` protobuf
//! -> `Payload{id,data}` -> schema-less body dump.
//!
//! Usage:
//!   sudo ./SniffSniffSquared                 # default device, filter "tcp"
//!   sudo ./SniffSniffSquared "tcp port 5555" # custom BPF filter
//!   DOFUS_DEV=en0 sudo ./SniffSniffSquared
//!   ./SniffSniffSquared --list               # list devices
//!
//! Runs on macOS, Linux and Windows — it is libpcap everywhere, Npcap
//! providing it on Windows. `--dev` takes an exact interface name (`en0`,
//! `eth0`) or, failing that, a fragment of the adapter description, because a
//! Windows name is `\Device\NPF_{GUID}`. See `match_device`.

mod dispatch;
mod dump;
mod flow;
mod frame;
mod framer;
mod interpret;
mod messages;
mod pb;
mod registry;

use dispatch::Dispatcher;
use flow::{FlowKey, Reassembler};
use registry::Registry;
use pcap::{Capture, Device, Linktype};
use pnet::packet::ethernet::{EtherTypes, EthernetPacket};
use pnet::packet::ip::IpNextHeaderProtocols;
use pnet::packet::ipv4::Ipv4Packet;
use pnet::packet::ipv6::Ipv6Packet;
use pnet::packet::tcp::TcpPacket;
use pnet::packet::Packet;
use std::cell::RefCell;
use std::collections::HashMap;
use std::net::IpAddr;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static RAW: AtomicBool = AtomicBool::new(false);
static SHOW_ALL: AtomicBool = AtomicBool::new(false);
static REG: OnceLock<Option<Registry>> = OnceLock::new();

fn main() {
    dotenvy::dotenv().ok(); // load .env so DATABASE_URL/DOFUS_DEV work under sudo
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--list") {
        list_devices();
        return;
    }
    // parse flags; strip them from positional args
    let mut dev_arg: Option<String> = None;
    let mut rest: Vec<String> = Vec::new();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dev" => dev_arg = it.next(),
            "--raw" => RAW.store(true, Ordering::Relaxed),
            "--all" => SHOW_ALL.store(true, Ordering::Relaxed),
            _ => rest.push(a),
        }
    }
    let bpf = rest.first().cloned().unwrap_or_else(|| "tcp".to_string());

    let km = messages::keymap();
    println!(
        "[*] message keymap: {} entries ({} from {}) — {}",
        km.len(),
        km.overridden(),
        messages::OVERRIDE_PATH,
        km.summary()
    );

    let _ = REG.set(Registry::load("proto/messages.json"));
    match REG.get().and_then(|o| o.as_ref()) {
        Some(r) => println!("[*] schema registry: {} messages", r.len()),
        None => println!("[*] no proto/messages.json — schema-less decode"),
    }

    let device = pick_device(dev_arg);
    let mode = if SHOW_ALL.load(Ordering::Relaxed) { "all frames" } else { "known only (--all for everything)" };
    println!("[*] capturing on {} (filter: {bpf}) [{mode}]", device.name);

    let mut cap = Capture::from_device(device)
        .expect("open device")
        .immediate_mode(true)
        .snaplen(65535)
        .open()
        .expect("start capture");
    cap.filter(&bpf, true).expect("bad BPF filter");

    let link = cap.get_datalink();
    let mut re = Reassembler::new();
    let mut dispatch = build_dispatch();

    while let Ok(packet) = cap.next_packet() {
        if let Some((ip_bytes, _)) = strip_link(link, packet.data) {
            handle_ip(&mut re, &mut dispatch, ip_bytes);
        }
    }
}

/// Announces a change to anyone LISTENing, so the web app can update without
/// polling. Prepended to every DDL block that installs a trigger using it, by
/// `with_notify` — each block runs on its own connection and none may assume
/// another ran first.
///
/// Statement-level, not row-level: a single item's stat lines arrive as several
/// inserts and the listener only needs to know *that* something changed.
const NOTIFY_FN: &str = "CREATE OR REPLACE FUNCTION notify_breaker() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('breaker', TG_TABLE_NAME);
    RETURN NULL;
END $$;";

/// `NOTIFY_FN` followed by a DDL block that depends on it.
fn with_notify(ddl: &str) -> String {
    format!("{NOTIFY_FN}\n{ddl}")
}

/// Marketplace prices from `kea`. Unlike the old `kdh` table this keeps
/// history — one row per observation — because the point of watching the
/// marketplace is how prices move, and an upsert throws that away.
///
/// It notifies like the crush tables do: the breaker page prices an item's
/// craft off this table, so browsing an ingredient in the HDV changes what that
/// page says while it is open. Without the trigger the figure only appears on
/// the next manual reload, which reads as the page being wrong.
const PRICES_DDL: &str = "CREATE TABLE IF NOT EXISTS prices (
    id          BIGSERIAL PRIMARY KEY,
    seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    item_id     BIGINT NOT NULL,
    category    BIGINT,
    listing_id  BIGINT,
    b1          BIGINT,
    b10         BIGINT,
    b100        BIGINT,
    b1000       BIGINT
);
CREATE INDEX IF NOT EXISTS idx_prices_item ON prices (item_id, seen_at DESC);
DROP TRIGGER IF EXISTS trg_prices_notify ON prices;
CREATE TRIGGER trg_prices_notify AFTER INSERT ON prices
    FOR EACH STATEMENT EXECUTE FUNCTION notify_breaker()";

const PRICES_INSERT: &str = "INSERT INTO prices
    (item_id, category, listing_id, b1, b10, b100, b1000) VALUES ($1,$2,$3,$4,$5,$6,$7)";

/// Individual marketplace offers, and the stats the copy on sale rolled.
///
/// Separate from `prices` because they answer different questions. A row in
/// `prices` is a stack quote for a fungible resource — one price per batch
/// size. A row here is one specific piece of gear somebody listed, at one
/// price, with the stats it happens to have. Browsing equipment produces
/// dozens at once, and folding them into `prices` meant recording the last
/// seller's asking price as if it were the market's.
///
/// Keyed by `(listing_id, seen_at)` so a listing re-observed at a new price
/// keeps both observations: the point of watching a market is the movement.
const OFFERS_DDL: &str = "CREATE TABLE IF NOT EXISTS offers (
    listing_id BIGINT      NOT NULL,
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    item_id    BIGINT      NOT NULL,
    category   BIGINT,
    price      BIGINT      NOT NULL,
    PRIMARY KEY (listing_id, seen_at)
);
CREATE INDEX IF NOT EXISTS idx_offers_item ON offers (item_id, seen_at DESC);
CREATE TABLE IF NOT EXISTS offer_stats (
    listing_id BIGINT NOT NULL,
    effect_id  BIGINT NOT NULL,
    item_id    BIGINT NOT NULL,
    value      BIGINT NOT NULL,
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (listing_id, effect_id)
);
CREATE INDEX IF NOT EXISTS idx_offer_stats_item ON offer_stats (item_id, effect_id);
DROP TRIGGER IF EXISTS trg_offers_notify ON offers;
CREATE TRIGGER trg_offers_notify AFTER INSERT ON offers
    FOR EACH STATEMENT EXECUTE FUNCTION notify_breaker()";

const OFFER_INSERT: &str = "INSERT INTO offers (listing_id, item_id, category, price)
    VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING";

const OFFER_STAT_INSERT: &str =
    "INSERT INTO offer_stats (listing_id, effect_id, item_id, value) VALUES ($1,$2,$3,$4)
     ON CONFLICT (listing_id, effect_id) DO UPDATE SET value = EXCLUDED.value,
     seen_at = now()";

/// Crushes ("brisage") and the runes each produced. Two tables because one
/// crush yields many rune types — up to 8 observed.
///
/// `crush_placements` records an item being put into the breaker. Placement and
/// crush are separate events — an item can sit in the slot and never be broken,
/// which is exactly what happens while choosing a focus — so it gets its own
/// table rather than a column on `crushes`.
///
/// The yield varies per crush and is the whole point of that table. Focus is
/// deliberately not recorded: it does not affect the yield, so the same item
/// crushed with any focus, or none, produces the same percentage.
///
/// `item_id` is nullable. The crush result carries only the item's instance
/// uid, and the type comes from an `item_detail` seen earlier; if capture
/// started mid-session that mapping is missing and the row lands without it.
const CRUSH_DDL: &str = "CREATE TABLE IF NOT EXISTS crushes (
    id            BIGSERIAL PRIMARY KEY,
    seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    item_id       BIGINT,
    yield_percent REAL NOT NULL
);
ALTER TABLE crushes DROP COLUMN IF EXISTS item_uid;
ALTER TABLE crushes DROP COLUMN IF EXISTS focus_rune_id;
ALTER TABLE crushes DROP COLUMN IF EXISTS focus_effect_id;
DROP TABLE IF EXISTS crush_runes;
CREATE TABLE IF NOT EXISTS crush_placements (
    id       BIGSERIAL PRIMARY KEY,
    placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    item_id  BIGINT NOT NULL
);
ALTER TABLE crush_placements ADD COLUMN IF NOT EXISTS uid BIGINT;
CREATE INDEX IF NOT EXISTS idx_placements_item ON crush_placements (item_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_crushes_item ON crushes (item_id, seen_at DESC);
DROP TRIGGER IF EXISTS trg_crush_placements_notify ON crush_placements;
CREATE TRIGGER trg_crush_placements_notify AFTER INSERT ON crush_placements
    FOR EACH STATEMENT EXECUTE FUNCTION notify_breaker();
DROP TRIGGER IF EXISTS trg_crushes_notify ON crushes;
CREATE TRIGGER trg_crushes_notify AFTER INSERT ON crushes
    FOR EACH STATEMENT EXECUTE FUNCTION notify_breaker()";

const CRUSH_INSERT: &str = "INSERT INTO crushes (item_id, yield_percent) VALUES ($1,$2)";
const PLACEMENT_INSERT: &str =
    "INSERT INTO crush_placements (item_id, uid) VALUES ($1,$2)";

/// Mirrors `item_stats` and `items` in init.sql, for databases created before
/// they existed. `items` is created but never written here — the sniffer takes
/// no network dependency, so names are filled offline by tools/import_items.py.
const ITEM_STATS_DDL: &str = "CREATE TABLE IF NOT EXISTS item_stats (
    uid       BIGINT NOT NULL,
    effect_id BIGINT NOT NULL,
    item_id   BIGINT NOT NULL,
    value     BIGINT NOT NULL,
    seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (uid, effect_id)
);
CREATE INDEX IF NOT EXISTS idx_item_stats_item ON item_stats (item_id);
DROP TRIGGER IF EXISTS trg_item_stats_notify ON item_stats;
CREATE TRIGGER trg_item_stats_notify AFTER INSERT ON item_stats
    FOR EACH STATEMENT EXECUTE FUNCTION notify_breaker();
CREATE TABLE IF NOT EXISTS items (
    item_id    BIGINT PRIMARY KEY,
    name_fr    TEXT,
    level      INT,
    type_id    BIGINT,
    type_fr    TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)";

// The same instance is described again every time it is handled, so a repeat is
// expected and is not new information. Overwrite rather than accumulate.
const ITEM_STAT_INSERT: &str = "INSERT INTO item_stats (uid, effect_id, item_id, value)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (uid, effect_id) DO UPDATE SET value = EXCLUDED.value, seen_at = now()";

/// What is actually in the bags, keyed by instance.
///
/// The listing the server sends is a full snapshot, so a snapshot replaces the
/// table rather than adding to it — an item sold while the sniffer was not
/// running has to disappear, and a table that only ever grows would keep
/// promising resources that are long gone.
///
/// Quantity is the stack size: 1 for equipment, which the wire leaves out
/// entirely, and the real count for resources. Two stacks of the same resource
/// are two rows, because the wire keeps them apart; anything asking "how many
/// do I have" sums by item_id.
const INVENTORY_DDL: &str = "CREATE TABLE IF NOT EXISTS inventory (
    uid      BIGINT PRIMARY KEY,
    item_id  BIGINT NOT NULL,
    quantity BIGINT NOT NULL,
    seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_item ON inventory (item_id);
DROP TRIGGER IF EXISTS trg_inventory_notify ON inventory;
CREATE TRIGGER trg_inventory_notify AFTER INSERT OR UPDATE OR DELETE ON inventory
    FOR EACH STATEMENT EXECUTE FUNCTION notify_breaker()";

const INVENTORY_INSERT: &str = "INSERT INTO inventory (uid, item_id, quantity)
    VALUES ($1,$2,$3)
    ON CONFLICT (uid) DO UPDATE SET item_id = EXCLUDED.item_id,
        quantity = EXCLUDED.quantity, seen_at = now()";

/// Matches the `packets` table in init.sql. Re-declared here so the sniffer
/// works against a database that was created before that table existed.
const PACKETS_DDL: &str = "CREATE TABLE IF NOT EXISTS packets (
    id          BIGSERIAL PRIMARY KEY,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    src         TEXT NOT NULL,
    dst         TEXT NOT NULL,
    msg_key     TEXT,
    body        BYTEA,
    vars        BIGINT[],
    packs       JSONB,
    decoded     JSONB
)";

const PACKETS_INSERT: &str =
    "INSERT INTO packets (src, dst, msg_key, body, vars, packs) VALUES ($1,$2,$3,$4,$5,$6)";

/// Register packet callbacks here. Each `on(key, ..)` fires when that message
/// arrives, with the decoded values in `e.values` (vars + packed arrays).
fn build_dispatch() -> Dispatcher {
    let mut d = Dispatcher::new();
    // Registered by semantic name, so a build that rotates the wire key needs
    // only messages::DEFAULTS or keymap.json updated — not this code.
    let price_key = match messages::keymap().key("price_list") {
        Some(k) => k.to_string(),
        None => {
            eprintln!("[keymap] no wire key for \"price_list\"; prices not collected");
            return d;
        }
    };
    match db_client_with(&with_notify(&format!("{PRICES_DDL};\n{OFFERS_DDL}"))) {
        Some(mut client) => {
            println!("[db] connected; price_list ({price_key}) -> table prices");
            d.on(&price_key, move |e| {
                if let Err(err) = insert_price(&mut client, e) {
                    eprintln!("[db] price insert failed: {err}");
                }
            });
        }
        None => {
            d.on(&price_key, |e| {
                if let Some(p) = interpret::price_list(e.body) {
                    eprintln!("[cb price_list] {p}");
                }
            });
        }
    }
    // Crushes. `item_detail` arrives first carrying uid -> item type id; the
    // crush result that follows has only the uid, so the mapping is cached to
    // join them. Bounded so a long session cannot grow it without limit.
    let uid_to_item: Rc<RefCell<HashMap<u64, u64>>> = Rc::new(RefCell::new(HashMap::new()));

    // A placement names only the uid; the type arrives in the item_detail that
    // answers it. So remember the uid here and write the row when that reply
    // resolves it.
    let awaiting_placement: Rc<RefCell<Option<u64>>> = Rc::new(RefCell::new(None));
    if let Some(put_key) = messages::keymap().key("crush_slot_put") {
        let pending = awaiting_placement.clone();
        d.on(put_key, move |e| {
            *pending.borrow_mut() = interpret::crush_slot_put(e.body);
        });
    }

    let mut placement_db = db_client_with(&with_notify(CRUSH_DDL));
    if placement_db.is_some() {
        println!("[db] connected; crush_slot_put -> table crush_placements");
    }
    let mut stats_db = db_client_with(&with_notify(ITEM_STATS_DDL));
    if stats_db.is_some() {
        println!("[db] connected; item_detail stat lines -> table item_stats");
    }
    // The bags. A listing replaces the table; a removal deletes one row; and an
    // item described on its own updates that row, which is how a stack that
    // grew between listings gets its new size.
    let mut inventory_db = db_client_with(&with_notify(INVENTORY_DDL));
    if inventory_db.is_some() {
        println!("[db] connected; inventory -> table inventory");
    }
    let mut detail_inventory_db = db_client_with(&with_notify(INVENTORY_DDL));
    if let Some(inventory_key) = messages::keymap().key("inventory") {
        d.on(inventory_key, move |e| {
            let Some(items) = interpret::inventory(e.body) else { return };
            // An empty listing is a real answer, but it is also what a parse
            // that quietly went wrong looks like, and acting on it would wipe
            // the table. A bag with nothing in it is not worth that risk.
            if items.is_empty() {
                return;
            }
            let Some(client) = inventory_db.as_mut() else { return };
            // One transaction: a half-applied snapshot would read as an
            // inventory that holds neither the old items nor all the new ones.
            let result = client.build_transaction().start().and_then(|mut tx| {
                tx.execute("DELETE FROM inventory", &[])?;
                for item in &items {
                    tx.execute(
                        INVENTORY_INSERT,
                        &[&(item.uid as i64), &(item.item_id as i64), &(item.quantity as i64)],
                    )?;
                }
                tx.commit()
            });
            if let Err(err) = result {
                eprintln!("[db] inventory snapshot failed: {err}");
            }
        });
    }
    if let Some(add_key) = messages::keymap().key("inventory_add") {
        let mut add_db = db_client_with(&with_notify(INVENTORY_DDL));
        d.on(add_key, move |e| {
            let Some(item) = interpret::inventory_add(e.body) else { return };
            if let Some(client) = add_db.as_mut() {
                let row: [&(dyn postgres::types::ToSql + Sync); 3] =
                    [&(item.uid as i64), &(item.item_id as i64), &(item.quantity as i64)];
                if let Err(err) = client.execute(INVENTORY_INSERT, &row) {
                    eprintln!("[db] inventory add failed: {err}");
                }
            }
        });
    }
    if let Some(qty_key) = messages::keymap().key("inventory_quantity") {
        let mut qty_db = db_client_with(&with_notify(INVENTORY_DDL));
        d.on(qty_key, move |e| {
            let Some((uid, quantity)) = interpret::inventory_quantity(e.body) else { return };
            if let Some(client) = qty_db.as_mut() {
                // The new size, not a delta: a row that drifted out of step
                // gets corrected here rather than compounding the drift. A
                // stack that ran out is a row that should go.
                let result = if quantity == 0 {
                    client.execute("DELETE FROM inventory WHERE uid = $1", &[&(uid as i64)])
                } else {
                    client.execute(
                        "UPDATE inventory SET quantity = $2, seen_at = now() WHERE uid = $1",
                        &[&(uid as i64), &(quantity as i64)],
                    )
                };
                if let Err(err) = result {
                    eprintln!("[db] inventory quantity failed: {err}");
                }
            }
        });
    }
    if let Some(gone_key) = messages::keymap().key("inventory_remove") {
        let mut gone_db = db_client_with(&with_notify(INVENTORY_DDL));
        d.on(gone_key, move |e| {
            let Some(uid) = interpret::inventory_remove(e.body) else { return };
            if let Some(client) = gone_db.as_mut() {
                if let Err(err) =
                    client.execute("DELETE FROM inventory WHERE uid = $1", &[&(uid as i64)])
                {
                    eprintln!("[db] inventory delete failed: {err}");
                }
            }
        });
    }

    if let Some(detail_key) = messages::keymap().key("item_detail") {
        let cache = uid_to_item.clone();
        let pending = awaiting_placement.clone();
        d.on(detail_key, move |e| {
            if let Some(detail) = interpret::item_detail_full(e.body) {
                let (uid, item) = (detail.uid, detail.item_id);
                // Only an item already in the bag: a detail also arrives for
                // things merely looked at — a marketplace listing, someone
                // else's gear — and those are not yours to count.
                if let Some(client) = detail_inventory_db.as_mut() {
                    let row: [&(dyn postgres::types::ToSql + Sync); 3] =
                        [&(uid as i64), &(item as i64), &(detail.quantity as i64)];
                    if let Err(err) = client.execute(
                        "UPDATE inventory SET item_id = $2, quantity = $3, seen_at = now()
                           WHERE uid = $1",
                        &row,
                    ) {
                        eprintln!("[db] inventory update failed: {err}");
                    }
                }
                if let Some(client) = stats_db.as_mut() {
                    for (effect, value) in &detail.stats {
                        let row: [&(dyn postgres::types::ToSql + Sync); 4] =
                            [&(uid as i64), &(*effect as i64), &(item as i64), value];
                        if let Err(err) = client.execute(ITEM_STAT_INSERT, &row) {
                            eprintln!("[db] item_stats insert failed: {err}");
                            break;
                        }
                    }
                }
                {
                    let mut m = cache.borrow_mut();
                    if m.len() > 4096 {
                        m.clear();
                    }
                    m.insert(uid, item);
                }
                // taken, so one placement can only ever produce one row
                if pending.borrow_mut().take_if(|p| *p == uid).is_some() {
                    if let Some(client) = placement_db.as_mut() {
                        if let Err(err) =
                            client.execute(PLACEMENT_INSERT, &[&(item as i64), &(uid as i64)])
                        {
                            eprintln!("[db] placement insert failed: {err}");
                        }
                    }
                }
            }
        });
    }
    if let Some(crush_key) = messages::keymap().key("crush_result") {
        let cache = uid_to_item.clone();
        match db_client_with(&with_notify(CRUSH_DDL)) {
            Some(mut client) => {
                println!("[db] connected; crush_result ({crush_key}) -> table crushes");
                d.on(crush_key, move |e| {
                    if let Some(c) = interpret::crush_result(e.body) {
                        let item = cache.borrow().get(&c.item_uid).copied();
                        if item.is_none() {
                            // the row is still worth having, but say so: without
                            // the type it cannot be grouped or resolved
                            eprintln!("[db] crush uid {} has no known item type", c.item_uid);
                        }
                        if let Err(err) = insert_crush(&mut client, &c, item) {
                            eprintln!("[db] crush insert failed: {err}");
                        }
                    }
                });
            }
            None => {
                d.on(crush_key, |e| {
                    if let Some(c) = interpret::crush_result(e.body) {
                        eprintln!("[cb crush] {c}");
                    }
                });
            }
        }
    }

    // Archive every message, interpreted or not. A second connection because
    // postgres::Client is not shareable, and this is the write we least want
    // to lose: it is what makes offline re-analysis possible without the game.
    if std::env::var("ARCHIVE_PACKETS").map(|v| v != "0").unwrap_or(true) {
        if let Some(mut client) = db_client_with(PACKETS_DDL) {
            println!("[db] archiving all messages -> table packets");
            let mut failed = 0usize;
            d.on_any(move |e| {
                if let Err(err) = insert_packet(&mut client, e) {
                    failed += 1;
                    // one line per failure would drown the capture
                    if failed == 1 || failed % 100 == 0 {
                        eprintln!("[db] packets insert failed ({failed} so far): {err}");
                    }
                }
            });
        }
    }
    d
}

/// Connect and run `ddl` to guarantee the target table exists.
fn db_client_with(ddl: &str) -> Option<postgres::Client> {
    let url = std::env::var("DATABASE_URL").ok()?;
    match postgres::Client::connect(&url, postgres::NoTls) {
        Ok(mut c) => match c.batch_execute(ddl) {
            Ok(()) => Some(c),
            Err(e) => {
                eprintln!("[db] CREATE TABLE failed: {e}");
                None
            }
        },
        Err(e) => {
            eprintln!("[db] connect failed ({e}); running without db");
            None
        }
    }
}

/// Archive one message verbatim: the raw body plus whatever decoded out of it.
/// The body is the point — a schema we do not have yet can be applied later.
fn insert_packet(
    client: &mut postgres::Client,
    e: &dispatch::Event,
) -> Result<(), postgres::Error> {
    let vars: Vec<i64> = e.values.vars.iter().map(|&v| v as i64).collect();
    let packs = serde_json::Value::Array(
        e.values
            .packs
            .iter()
            .map(|p| {
                serde_json::Value::Array(
                    p.iter().map(|&v| serde_json::Value::from(v as i64)).collect(),
                )
            })
            .collect(),
    );
    client.execute(
        PACKETS_INSERT,
        &[&e.src, &e.dst, &e.key, &e.body, &vars, &packs],
    )?;
    Ok(())
}

/// One row per crush. The runes it produced are not stored — see CRUSH_DDL.
fn insert_crush(
    client: &mut postgres::Client,
    c: &interpret::CrushResult,
    item_id: Option<u64>,
) -> Result<(), postgres::Error> {
    client.execute(
        CRUSH_INSERT,
        &[&item_id.map(|v| v as i64), &(c.yield_fraction * 100.0)],
    )?;
    Ok(())
}

/// One row per observed price, so history is preserved.
///
/// Which table depends on what the offer is: a single copy of gear goes to
/// `offers`, a stack quote goes to `prices` as a ladder. `Offer::is_single_copy`
/// decides, and it reads the ladder rather than the stats — a rune carries a
/// stat line of its own and is still a stack.
///
/// Sending gear to `prices` claims x10 and x100 quotes that do not exist;
/// sending a stack to `offers` invents a listing for something with no
/// individual identity, and quietly stops its ladder reaching the table every
/// rune price and craft cost is read from.
fn insert_price(
    client: &mut postgres::Client,
    e: &dispatch::Event,
) -> Result<(), postgres::Error> {
    let p = match interpret::price_list(e.body) {
        Some(p) => p,
        None => return Ok(()), // not a price message after all
    };
    for offer in &p.offers {
        if !offer.is_single_copy() {
            let at = |i: usize| offer.ladder.get(i).map(|&v| v as i64);
            client.execute(
                PRICES_INSERT,
                &[
                    &(offer.item_id as i64),
                    &(p.category as i64),
                    &(offer.listing_id as i64),
                    &at(0),
                    &at(1),
                    &at(2),
                    &at(3),
                ],
            )?;
            continue;
        }
        client.execute(
            OFFER_INSERT,
            &[
                &(offer.listing_id as i64),
                &(offer.item_id as i64),
                &(p.category as i64),
                &(offer.unit_price() as i64),
            ],
        )?;
        for (effect_id, value) in &offer.stats {
            client.execute(
                OFFER_STAT_INSERT,
                &[
                    &(offer.listing_id as i64),
                    &(*effect_id as i64),
                    &(offer.item_id as i64),
                    value,
                ],
            )?;
        }
    }
    Ok(())
}

fn pick_device(dev_arg: Option<String>) -> Device {
    // precedence: --dev flag, then DOFUS_DEV env, then default
    if let Some(name) = dev_arg.or_else(|| std::env::var("DOFUS_DEV").ok()) {
        let devices = Device::list().unwrap_or_default();
        // a mistyped interface is user error, not a bug — report it plainly
        // instead of a panic backtrace, which buries the candidate list
        let device = match_device(devices, &name).unwrap_or_else(|e| {
            eprintln!("[!] {e}");
            std::process::exit(1);
        });
        if let Some(w) = disconnected_warning(&device) {
            eprintln!("[!] {w}");
        }
        return device;
    }
    Device::lookup().expect("device lookup").expect("no default device")
}

/// Warn when the chosen adapter cannot plausibly carry the game's traffic.
///
/// An interface holding only a link-local address (169.254/16, fe80::/10) never
/// completed DHCP — an unplugged NIC, typically. It opens and captures happily
/// and returns nothing at all, which is indistinguishable from a game that is
/// closed, the wrong BPF filter, or a rotated protocol. This cost a session:
/// a machine with both an idle Realtek port and a live Wi-Fi card, capturing on
/// the Realtek. Loopback keeps 127.0.0.1/::1 and is left alone, since
/// `tools/replay.py` targets it deliberately.
///
/// An interface holding *no* address is a different situation and is left alone
/// too: bridges, taps and mirror ports carry traffic without owning an IP, and
/// macOS lists a dozen of them (`bridge0`, `gif0`, `en1`..`en6`). Only a
/// link-local address is evidence that DHCP was attempted and failed. Costs
/// nothing on Windows, which self-assigns 169.254/16 rather than leaving an
/// enabled adapter address-less.
fn disconnected_warning(device: &Device) -> Option<String> {
    if device.addresses.is_empty() {
        return None;
    }
    let routable = device.addresses.iter().any(|a| match a.addr {
        IpAddr::V4(v4) => !v4.is_link_local() && !v4.is_loopback(),
        IpAddr::V6(v6) => !is_v6_link_local(&v6) && !v6.is_loopback(),
    });
    if routable || device.addresses.iter().any(|a| a.addr.is_loopback()) {
        return None;
    }
    Some(format!(
        "{} has no routable address — it is probably not connected, and will \
         capture nothing. Check --list for the adapter holding your LAN IP.",
        device.name
    ))
}

/// `Ipv6Addr::is_unicast_link_local` is still unstable, so test fe80::/10 here.
fn is_v6_link_local(addr: &std::net::Ipv6Addr) -> bool {
    (addr.segments()[0] & 0xffc0) == 0xfe80
}

/// Resolve a user-supplied device string against the live device list.
///
/// Exact name first, so `en0`/`eth0` keep resolving to exactly themselves and
/// can never be shadowed by a substring hit elsewhere in the list. Only if that
/// misses do we try a case-insensitive substring of the name or description —
/// which is what makes this usable on Windows, where the real name is
/// `\Device\NPF_{A3307B35-BC43-...}` and nobody is typing a GUID by hand:
/// `--dev Wi-Fi` or `--dev Realtek` finds it via the adapter description.
///
/// A bound address matches too, so `--dev 192.168.1.10` picks the adapter
/// holding that IP. Descriptions are marketing names that say nothing about
/// which card is actually on the network; the address is the part the user can
/// check against `ipconfig`.
///
/// An ambiguous substring is an error rather than a silent pick. Windows lists
/// several near-identical virtual adapters, and quietly capturing on the wrong
/// one looks exactly like a game that sends no traffic.
fn match_device(devices: Vec<Device>, name: &str) -> Result<Device, String> {
    if let Some(d) = devices.iter().find(|d| d.name == name) {
        return Ok(d.clone());
    }

    let needle = name.to_lowercase();
    let hits: Vec<&Device> = devices
        .iter()
        .filter(|d| {
            d.name.to_lowercase().contains(&needle)
                || d.desc
                    .as_deref()
                    .is_some_and(|s| s.to_lowercase().contains(&needle))
                || d.addresses
                    .iter()
                    .any(|a| a.addr.to_string().to_lowercase() == needle)
        })
        .collect();

    match hits.as_slice() {
        [] => Err(format!("device {name} not found (try --list)")),
        [d] => Ok((*d).clone()),
        many => {
            let list = many
                .iter()
                .map(|d| format!("\n    {}\t{}", d.name, d.desc.clone().unwrap_or_default()))
                .collect::<String>();
            Err(format!(
                "device {name} is ambiguous, {} matches:{list}\n  narrow it, or pass the exact name",
                many.len()
            ))
        }
    }
}

fn list_devices() {
    for d in Device::list().unwrap_or_default() {
        // addresses disambiguate the Windows list, where several adapters share
        // a description and only the bound IP says which one is the live link
        let addrs = d
            .addresses
            .iter()
            .map(|a| a.addr.to_string())
            .collect::<Vec<_>>()
            .join(",");
        println!("{}\t{}\t{}", d.name, d.desc.unwrap_or_default(), addrs);
    }
}

/// Strip the link-layer header, returning the inner IP packet bytes.
fn strip_link(link: Linktype, data: &[u8]) -> Option<(&[u8], ())> {
    match link {
        Linktype::ETHERNET => {
            let eth = EthernetPacket::new(data)?;
            match eth.get_ethertype() {
                EtherTypes::Ipv4 | EtherTypes::Ipv6 => {
                    let off = 14;
                    Some((&data[off..], ()))
                }
                _ => None,
            }
        }
        // BSD loopback (DLT_NULL): 4-byte address-family header
        Linktype::NULL | Linktype(108) => data.get(4..).map(|b| (b, ())),
        Linktype::RAW | Linktype(12) | Linktype(14) => Some((data, ())),
        _ => {
            // best effort: assume ethernet
            data.get(14..).map(|b| (b, ()))
        }
    }
}

fn handle_ip(re: &mut Reassembler, dispatch: &mut Dispatcher, ip: &[u8]) {
    let version = ip.first().map(|b| b >> 4).unwrap_or(0);
    match version {
        4 => {
            if let Some(p) = Ipv4Packet::new(ip) {
                if p.get_next_level_protocol() == IpNextHeaderProtocols::Tcp {
                    handle_tcp(re, dispatch, IpAddr::V4(p.get_source()), IpAddr::V4(p.get_destination()), p.payload());
                }
            }
        }
        6 => {
            if let Some(p) = Ipv6Packet::new(ip) {
                if p.get_next_header() == IpNextHeaderProtocols::Tcp {
                    handle_tcp(re, dispatch, IpAddr::V6(p.get_source()), IpAddr::V6(p.get_destination()), p.payload());
                }
            }
        }
        _ => {}
    }
}

/// Classic offset + hex + ASCII dump.
fn hexdump(b: &[u8]) -> String {
    let mut out = String::new();
    for (i, chunk) in b.chunks(16).enumerate() {
        let hex: String = chunk.iter().map(|x| format!("{x:02x} ")).collect();
        let ascii: String = chunk
            .iter()
            .map(|&x| if (0x20..0x7f).contains(&x) { x as char } else { '.' })
            .collect();
        out.push_str(&format!("  {:04x}  {:<48}  {ascii}\n", i * 16, hex));
    }
    out
}

fn handle_tcp(re: &mut Reassembler, dispatch: &mut Dispatcher, src: IpAddr, dst: IpAddr, tcp_bytes: &[u8]) {
    let tcp = match TcpPacket::new(tcp_bytes) {
        Some(t) => t,
        None => return,
    };
    let key = FlowKey { src, sport: tcp.get_source(), dst, dport: tcp.get_destination() };
    let seq = tcp.get_sequence();
    let payload = tcp.payload();
    if payload.is_empty() {
        return;
    }
    if RAW.load(Ordering::Relaxed) {
        println!("\n[{key}] seq={seq} len={}", payload.len());
        println!("{}", hexdump(payload));
        return;
    }
    let frames = re.push(key, seq, payload);
    if frames.is_empty() {
        return;
    }
    if let Some(layout) = re.announce(&key) {
        eprintln!("[{key}] framing locked: {layout}");
    }
    let reg = REG.get().and_then(|o| o.as_ref());
    let show_all = SHOW_ALL.load(Ordering::Relaxed);

    // fire callbacks for every message a frame carries (independent of display)
    if let Some(r) = reg {
        if !dispatch.is_empty() {
            for d in &frames {
                let mut anys = Vec::new();
                dump::collect_any(&d.body, &mut anys);
                for (mkey, mbody) in anys {
                    let (src, dst) = (
                        format!("{}:{}", key.src, key.sport),
                        format!("{}:{}", key.dst, key.dport),
                    );
                    dispatch.dispatch(&mkey, &mbody, r, &src, &dst);
                }
            }
        }
    }

    for d in frames {
        // default: only frames we have an interpreter for; --all shows everything
        if !show_all && !dump::has_known(&d.body) {
            continue;
        }
        // game-server Frame carries a routing id; note it when present
        let hdr = match &d.frame {
            Some(f) if f.payload().id != 0 || !f.payload().data.is_empty() => {
                let p = f.payload();
                format!("{} id=0x{:08X} ({})", f.kind(), p.id as u32, p.id)
            }
            _ => format!("body {}B", d.body.len()),
        };
        println!("\n[{key}] {hdr}");
        print!("{}", dump::dump(&d.body, reg, None, 1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcap::{Address, DeviceFlags};

    fn addr(ip: &str) -> Address {
        Address {
            addr: ip.parse().expect("test address"),
            netmask: None,
            broadcast_addr: None,
            dst_addr: None,
        }
    }

    /// Device names, descriptions and addresses as the three platforms really
    /// report them: macOS/Linux short names, Windows `\Device\NPF_{GUID}` plus
    /// the adapter description that is the only human-readable handle it
    /// offers. Transcribed from a real Windows 11 `--list`, where the Realtek
    /// port sat unplugged on a link-local address while Wi-Fi carried the game.
    fn devices() -> Vec<Device> {
        [
            ("en0", "Wi-Fi", vec!["192.168.1.10"]),
            ("eth0", "", vec!["10.0.0.5"]),
            (r"\Device\NPF_{A3307B35-BC43-4EB9-AEE9-945220A94001}", "Intel(R) Wi-Fi 6E AX211 160MHz", vec!["192.168.1.10", "fe80::ff58:9607:2401:f390"]),
            (r"\Device\NPF_{31AC96FC-C2C5-4413-956C-F0BA34878BC7}", "Realtek Gaming 2.5GbE Family Controller", vec!["169.254.46.67", "fe80::9286:4838:bf0d:64ce"]),
            (r"\Device\NPF_{DC279F37-0CC3-41A5-A89B-F41E75DF7D7F}", "Microsoft Wi-Fi Direct Virtual Adapter", vec!["169.254.199.204"]),
            (r"\Device\NPF_Loopback", "Adapter for loopback traffic capture", vec!["127.0.0.1", "::1"]),
        ]
        .into_iter()
        .map(|(name, desc, ips)| Device {
            name: name.to_string(),
            desc: (!desc.is_empty()).then(|| desc.to_string()),
            addresses: ips.into_iter().map(addr).collect(),
            flags: DeviceFlags::empty(),
        })
        .collect()
    }

    fn by_name(name: &str) -> Device {
        devices().into_iter().find(|d| d.name == name).expect("fixture")
    }

    /// The unix path must not regress: an exact name resolves to itself even
    /// though "en0" is also a substring of nothing else and "eth0" has no desc.
    #[test]
    fn exact_name_wins() {
        assert_eq!(match_device(devices(), "en0").unwrap().name, "en0");
        assert_eq!(match_device(devices(), "eth0").unwrap().name, "eth0");
    }

    /// Exact match takes precedence over a substring hit elsewhere. Here "en0"
    /// is exact for the macOS device; nothing may outrank that.
    #[test]
    fn exact_beats_substring() {
        let mut devs = devices();
        devs.push(Device {
            name: "bridge-en0-shadow".to_string(),
            desc: Some("en0 mirror".to_string()),
            addresses: vec![],
            flags: DeviceFlags::empty(),
        });
        assert_eq!(match_device(devs, "en0").unwrap().name, "en0");
    }

    /// The Windows win: name the adapter, not the GUID.
    #[test]
    fn matches_windows_description() {
        let d = match_device(devices(), "Realtek").unwrap();
        assert_eq!(d.name, r"\Device\NPF_{31AC96FC-C2C5-4413-956C-F0BA34878BC7}");
    }

    #[test]
    fn description_match_is_case_insensitive() {
        let d = match_device(devices(), "realtek gaming").unwrap();
        assert_eq!(d.name, r"\Device\NPF_{31AC96FC-C2C5-4413-956C-F0BA34878BC7}");
    }

    /// A GUID fragment is a name substring, so pasting part of one works.
    #[test]
    fn matches_name_substring() {
        let d = match_device(devices(), "31AC96FC").unwrap();
        assert_eq!(d.name, r"\Device\NPF_{31AC96FC-C2C5-4413-956C-F0BA34878BC7}");
    }

    /// "Wi-Fi" hits the Intel adapter and the Microsoft virtual one. Capturing
    /// on the wrong one yields zero packets and looks like a dead game, so this
    /// must report rather than guess.
    #[test]
    fn ambiguous_substring_errors_and_lists_candidates() {
        let err = match_device(devices(), "Wi-Fi").unwrap_err();
        assert!(err.contains("ambiguous"), "{err}");
        assert!(err.contains("Intel(R) Wi-Fi 6E AX211 160MHz"), "{err}");
        assert!(err.contains("Microsoft Wi-Fi Direct Virtual Adapter"), "{err}");
    }

    #[test]
    fn unknown_device_errors() {
        let err = match_device(devices(), "wlan9").unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(err.contains("--list"), "{err}");
    }

    /// Addressing the adapter by the IP `ipconfig` shows. "192.168.1.10" is on
    /// both en0 and the Intel card, but those are the same machine's two
    /// platform views of the fixture, so restrict to the Windows subset.
    #[test]
    fn matches_bound_address() {
        let windows: Vec<Device> = devices()
            .into_iter()
            .filter(|d| d.name.starts_with(r"\Device"))
            .collect();
        let d = match_device(windows, "192.168.1.10").unwrap();
        assert_eq!(d.name, r"\Device\NPF_{A3307B35-BC43-4EB9-AEE9-945220A94001}");
    }

    /// An address must match whole. A bare "192.168.1.1" is a different host
    /// than "192.168.1.10" and must not be treated as a prefix of it.
    #[test]
    fn address_match_is_not_a_prefix() {
        let windows: Vec<Device> = devices()
            .into_iter()
            .filter(|d| d.name.starts_with(r"\Device"))
            .collect();
        assert!(match_device(windows, "192.168.1.1").is_err());
    }

    /// The trap that cost a session: an unplugged NIC captures cleanly and
    /// returns nothing, which reads as a closed game or a rotated protocol.
    #[test]
    fn link_local_only_adapter_is_flagged() {
        let w = disconnected_warning(&by_name(
            r"\Device\NPF_{31AC96FC-C2C5-4413-956C-F0BA34878BC7}",
        ));
        assert!(w.is_some_and(|w| w.contains("not connected")));
    }

    #[test]
    fn connected_adapter_is_not_flagged() {
        assert!(disconnected_warning(&by_name(
            r"\Device\NPF_{A3307B35-BC43-4EB9-AEE9-945220A94001}"
        ))
        .is_none());
        assert!(disconnected_warning(&by_name("en0")).is_none());
    }

    /// `tools/replay.py` targets loopback on purpose — it must stay quiet.
    #[test]
    fn loopback_is_not_flagged() {
        assert!(disconnected_warning(&by_name(r"\Device\NPF_Loopback")).is_none());
    }

    /// A bridge or mirror port carries traffic while holding no address of its
    /// own, and macOS lists a dozen such devices. Only link-local-only is
    /// evidence of a failed DHCP, so no addresses at all must not warn — a
    /// warning on a correct choice teaches the user to ignore the real one.
    #[test]
    fn address_less_adapter_is_not_flagged() {
        let bridge = Device {
            name: "bridge0".to_string(),
            desc: None,
            addresses: vec![],
            flags: DeviceFlags::empty(),
        };
        assert!(disconnected_warning(&bridge).is_none());
    }
}
