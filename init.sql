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
