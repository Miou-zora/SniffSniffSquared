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
-- Your own verdict on an item, and the settings behind the automatic one.
--
-- The only two tables the web app writes to. Everything else here is capture,
-- and the sniffer owns it; these are annotations, so they carry no game data
-- and losing them costs an opinion rather than an observation.
--
-- A manual mark beats the computed verdict deliberately. The automatic one
-- knows the runes and the market; it does not know that an item is part of a
-- set you are keeping, or that the only listing was a fat-fingered price.
CREATE TABLE IF NOT EXISTS item_marks (
    item_id    BIGINT PRIMARY KEY,
    -- 'worth' or 'skip'. Free text rather than an enum so a new verdict does
    -- not need a migration in a schema that is otherwise append-only.
    status     TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Individual marketplace offers, and the stats the copy on sale rolled.
--
-- `prices` and this table are both "what the market says" and they are not the
-- same thing. A price row is a stack quote for a fungible resource: one price
-- per batch size, and any two units are interchangeable. A row here is one
-- specific piece of gear somebody listed, at one price, with the stats it
-- happens to carry -- browsing equipment yields dozens at once, each a
-- different roll of the same item type.
--
-- The wire tells them apart with no guesswork: an offer carrying stat lines is
-- a single copy, an offer without them is a stack.
--
-- This is also the only source of *observed* rolls beyond the items you have
-- held yourself. item_effects says what an item type can roll; this says what
-- the copies actually on sale did roll.
CREATE TABLE IF NOT EXISTS offers (
    listing_id BIGINT      NOT NULL,
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    item_id    BIGINT      NOT NULL,
    category   BIGINT,
    price      BIGINT      NOT NULL,
    -- keyed with the timestamp so a relisting at a new price keeps both
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
    item_id   BIGINT NOT NULL,
    uid       BIGINT              -- instance uid, joins to item_stats.uid
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

-- The stat ranges an item *type* can roll, from DofusDB. Filled by
-- tools/import_items.py alongside `items`.
--
-- Distinct from `item_stats`, which is what one instance actually rolled. This
-- is the template: what a copy of the item could have. Averaging these ranges
-- gives the expected line weight of an unseen copy, which is what a "what is
-- this item worth broken" estimate needs before you own one.
--
-- Keyed by position rather than effect id, so a template that lists the same
-- effect twice survives. `to` comes back as 0 from DofusDB for fixed-value
-- lines, so a stored max is always >= min.
CREATE TABLE IF NOT EXISTS item_effects (
    item_id   BIGINT NOT NULL,
    position  INT    NOT NULL,      -- order within the template
    effect_id BIGINT NOT NULL,
    min_value BIGINT NOT NULL,
    max_value BIGINT NOT NULL,
    PRIMARY KEY (item_id, position)
);

CREATE INDEX IF NOT EXISTS idx_item_effects_effect ON item_effects (effect_id);

-- What an item costs to make, as ingredient ids and counts, from DofusDB via
-- tools/import_items.py. Filled offline for the same reason as item_effects:
-- the capture path takes no network dependency.
--
-- This is the second answer to "what did this item cost", next to the market
-- price in `prices`. They disagree often and both are worth having -- a crafted
-- item's real cost is what its ingredients cost, which can sit far below what a
-- copy sells for, and the brisage decision is made against whichever one you
-- actually paid.
--
-- Keyed by position, like item_effects: a recipe may list the same ingredient
-- twice, and a recipe that loses an ingredient between game versions must lose
-- the row rather than keep a stale one.
CREATE TABLE IF NOT EXISTS recipes (
    item_id       BIGINT NOT NULL,
    position      INT    NOT NULL,   -- order within the recipe
    ingredient_id BIGINT NOT NULL,
    quantity      INT    NOT NULL,
    PRIMARY KEY (item_id, position)
);

CREATE INDEX IF NOT EXISTS idx_recipes_ingredient ON recipes (ingredient_id);

-- Expected line weight per stat line of an item type, from the middle of its
-- range. The formula is docs/brisage-model.md's `line_weight`, including the
-- +1 every line carries -- dropping that term is what broke the focus model
-- once already.
--
-- Lines whose effect maps to no rune are dropped by the join: weapon damage
-- lines and maluses yield nothing and are excluded from the weight the model
-- sums. `item_break_weight` counts them so their absence is visible rather
-- than silent.
CREATE OR REPLACE VIEW item_effect_weights AS
SELECT e.item_id,
       e.position,
       e.effect_id,
       r.rune,
       r.rune_weight,
       (e.min_value + e.max_value) / 2.0                       AS avg_value,
       3 * ((e.min_value + e.max_value) / 2.0) * r.rune_weight
         / r.stat_per_rune * i.level / 200 + 1                 AS avg_line_weight
FROM item_effects e
JOIN items i USING (item_id)
JOIN runes r ON r.effect_id = e.effect_id;

CREATE OR REPLACE VIEW item_break_weight AS
SELECT i.item_id,
       i.name_fr,
       i.level,
       count(w.position)                                    AS rune_lines,
       (SELECT count(*) FROM item_effects e2
         WHERE e2.item_id = i.item_id)                      AS template_lines,
       COALESCE(sum(w.avg_line_weight), 0)                  AS avg_total_weight
FROM items i
LEFT JOIN item_effect_weights w USING (item_id)
GROUP BY i.item_id, i.name_fr, i.level;

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
