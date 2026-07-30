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
use std::net::IpAddr;
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

/// Marketplace prices from `kea`. Unlike the old `kdh` table this keeps
/// history — one row per observation — because the point of watching the
/// marketplace is how prices move, and an upsert throws that away.
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
CREATE INDEX IF NOT EXISTS idx_prices_item ON prices (item_id, seen_at DESC)";

const PRICES_INSERT: &str = "INSERT INTO prices
    (item_id, category, listing_id, b1, b10, b100, b1000) VALUES ($1,$2,$3,$4,$5,$6,$7)";

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
    // only messages::DEFAULTS or proto/keymap.json updated — not this code.
    let price_key = match messages::keymap().key("price_list") {
        Some(k) => k.to_string(),
        None => {
            eprintln!("[keymap] no wire key for \"price_list\"; prices not collected");
            return d;
        }
    };
    match db_client_with(PRICES_DDL) {
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

/// One row per observed price ladder, so history is preserved.
fn insert_price(
    client: &mut postgres::Client,
    e: &dispatch::Event,
) -> Result<(), postgres::Error> {
    let p = match interpret::price_list(e.body) {
        Some(p) => p,
        None => return Ok(()), // not a price message after all
    };
    let at = |i: usize| p.ladder.get(i).map(|&v| v as i64);
    client.execute(
        PRICES_INSERT,
        &[
            &(p.item_id as i64),
            &(p.category as i64),
            &(p.listing_id as i64),
            &at(0),
            &at(1),
            &at(2),
            &at(3),
        ],
    )?;
    Ok(())
}

fn pick_device(dev_arg: Option<String>) -> Device {
    // precedence: --dev flag, then DOFUS_DEV env, then default
    if let Some(name) = dev_arg.or_else(|| std::env::var("DOFUS_DEV").ok()) {
        return Device::list()
            .unwrap_or_default()
            .into_iter()
            .find(|d| d.name == name)
            .unwrap_or_else(|| panic!("device {name} not found (try --list)"));
    }
    Device::lookup().expect("device lookup").expect("no default device")
}

fn list_devices() {
    for d in Device::list().unwrap_or_default() {
        println!("{}\t{}", d.name, d.desc.unwrap_or_default());
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
