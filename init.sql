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
