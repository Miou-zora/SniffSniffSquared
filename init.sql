-- Schema for captured Dofus 3 packets. Runs once on first db init.

CREATE TABLE IF NOT EXISTS packets (
    id          BIGSERIAL PRIMARY KEY,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    src         TEXT NOT NULL,          -- "ip:port"
    dst         TEXT NOT NULL,          -- "ip:port"
    msg_key     TEXT,                   -- Any type key, e.g. "kdh"
    body        BYTEA,                  -- raw message protobuf bytes
    vars        BIGINT[],               -- decoded scalar varints, in order
    packs       JSONB,                  -- decoded packed repeated arrays
    decoded     JSONB                   -- optional full decoded tree
);

CREATE INDEX IF NOT EXISTS idx_packets_msg_key     ON packets (msg_key);
CREATE INDEX IF NOT EXISTS idx_packets_captured_at ON packets (captured_at);

-- Marketplace prices, decoded from the `kea` message. One row per observation
-- so price history is preserved; the item is identified by item_id.
CREATE TABLE IF NOT EXISTS prices (
    id         BIGSERIAL PRIMARY KEY,
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    item_id    BIGINT NOT NULL,
    category   BIGINT,
    listing_id BIGINT,
    b1         BIGINT,               -- price for x1
    b10        BIGINT,               -- x10
    b100       BIGINT,               -- x100
    b1000      BIGINT                -- x1000  (0 = that batch not on sale)
);

CREATE INDEX IF NOT EXISTS idx_prices_item ON prices (item_id, seen_at DESC);

-- Crushing an item into runes ("brisage"), decoded from `crush_result`.
--
-- Only the yield is recorded, because only the yield varies:
--   * the runes produced follow from the item's stats and the coefficient
--   * the focus does not change the coefficient, so the same item crushed with
--     any focus, or none, yields the same percentage
--   * the item instance id identifies one destroyed copy and says nothing about
--     what it was
-- The raw messages stay in `packets`, so runes, focus and instance ids all
-- remain recoverable if a derivation ever needs checking.
CREATE TABLE IF NOT EXISTS crushes (
    id            BIGSERIAL PRIMARY KEY,
    seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    item_id       BIGINT,               -- type id; NULL if the uid was never mapped
    yield_percent REAL NOT NULL         -- 0-100, from a float32 fraction on the wire
);


CREATE INDEX IF NOT EXISTS idx_crushes_item ON crushes (item_id, seen_at DESC);

-- An item being put into the breaker's slot. Separate from `crushes` because
-- the two are separate events: an item can sit in the slot and never be broken,
-- which is what happens while a focus is being chosen.
CREATE TABLE IF NOT EXISTS crush_placements (
    id        BIGSERIAL PRIMARY KEY,
    placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    item_id   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_placements_item ON crush_placements (item_id, placed_at DESC);

-- The stat lines an item instance actually carried, straight off the wire.
--
-- This is the ground truth for an item's rolled values, and the only source for
-- them: the instance is usually destroyed by the crush that follows, and
-- DofusDB gives only the possible range for the item *type* -- a range that for
-- at least one captured item does not contain what the wire reported.
--
-- Keyed by instance uid, not item type: two copies of the same item roll
-- different values, and that difference is the whole point. `item_id` is
-- carried alongside so stats can be grouped by type without a join.
CREATE TABLE IF NOT EXISTS item_stats (
    uid       BIGINT NOT NULL,        -- instance uid, unique to one copy
    effect_id BIGINT NOT NULL,        -- joins to runes.effect_id
    item_id   BIGINT NOT NULL,        -- type id, joins to items.item_id
    value     BIGINT NOT NULL,        -- the rolled value
    seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (uid, effect_id)
);

CREATE INDEX IF NOT EXISTS idx_item_stats_item ON item_stats (item_id);

-- Item name/level/type, resolved from DofusDB by tools/import_items.py.
--
-- Deliberately not filled by the sniffer: the capture path stays free of
-- network dependencies, so enrichment is a separate offline step. Rows appear
-- only for item ids that were actually observed.
CREATE TABLE IF NOT EXISTS items (
    item_id    BIGINT PRIMARY KEY,
    name_fr    TEXT,
    level      INT,
    type_id    BIGINT,
    type_fr    TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rune reference: game constants from docs/brisage-runes.json, plus the DofusDB
-- ids that join them to captured data. Loaded by tools/import_runes.py, which
-- also creates this table; declared here so the schema is readable in one place.
CREATE TABLE IF NOT EXISTS runes (
    rune          TEXT PRIMARY KEY,   -- short name, e.g. 'Vi'
    stat_fr       TEXT NOT NULL,
    rune_weight   REAL NOT NULL,      -- game constant
    stat_per_rune REAL NOT NULL,
    item_id       BIGINT,             -- DofusDB item id
    effect_id     BIGINT              -- joins to item_detail effects and the crush focus
);

CREATE INDEX IF NOT EXISTS idx_runes_effect ON runes (effect_id);
