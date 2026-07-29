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

-- kdh message: id = first varint (unique); b1/b10/b100/b1000 = packed batches.
CREATE TABLE IF NOT EXISTS kdh (
    id         BIGINT PRIMARY KEY,   -- first varint
    b1         BIGINT,               -- packed[0]  (batch 1)
    b10        BIGINT,               -- packed[1]  (batch 10)
    b100       BIGINT,               -- packed[2]  (batch 100)
    b1000      BIGINT,               -- packed[3]  (batch 1000)
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
