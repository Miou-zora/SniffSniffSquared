#!/bin/sh
# One compressed dump of the whole database, plus pruning of old ones.
#
# Exists because the captured data is not reproducible. `items`, `recipes` and
# `item_effects` can be refetched from DofusDB, but `packets`, `prices`,
# `offers`, `crushes`, `item_stats` and `inventory` are observations of a live
# server at a moment that will not come back -- and `item_stats` describes item
# instances the crush destroyed, so nothing else ever recorded them. A deleted
# volume takes all of it, which has already happened once here.
#
# Run by the `db-backup` compose service on a loop; also usable by hand:
#
#     docker compose exec db-backup /tools/backup_db.sh
#
# Restore with tools/restore_db.sh.

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-24}"
PGHOST="${PGHOST:-db}"
PGUSER="${PGUSER:-dofus}"
PGDATABASE="${PGDATABASE:-dofus}"
export PGHOST PGUSER PGDATABASE

stamp=$(date -u +%Y%m%d-%H%M%SZ)
final="$BACKUP_DIR/dofus-$stamp.dump"
# Written under a temporary name and renamed only on success. A dump killed
# half-written must never be left looking like a good one -- that is the file
# you would reach for at the worst possible moment.
tmp="$BACKUP_DIR/.in-progress-$stamp.dump"

mkdir -p "$BACKUP_DIR"

# -Fc: postgres' own compressed format. Restores selectively and in parallel,
# where a plain SQL file is all-or-nothing.
if ! pg_dump -Fc --file="$tmp" "$PGDATABASE"; then
    rm -f "$tmp"
    echo "[backup] pg_dump failed for $PGDATABASE on $PGHOST" >&2
    exit 1
fi

# A dump that restores nothing is worse than no dump, because it reads as one.
# `pg_restore -l` parses the archive's table of contents without touching a
# database, so it is a cheap check that the file is complete and readable.
if ! pg_restore -l "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "[backup] dump did not verify, discarded" >&2
    exit 1
fi

mv "$tmp" "$final"
size=$(ls -lh "$final" | awk '{print $5}')
echo "[backup] $(basename "$final") ($size)"

# Keep the newest BACKUP_KEEP, delete the rest. Sorted by name, which sorts by
# time because the stamp is ISO-ordered and UTC -- no locale or DST surprises.
count=$(ls -1 "$BACKUP_DIR"/dofus-*.dump 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -gt "$BACKUP_KEEP" ]; then
    ls -1 "$BACKUP_DIR"/dofus-*.dump | sort | head -n "$((count - BACKUP_KEEP))" |
        while read -r old; do
            rm -f "$old"
            echo "[backup] pruned $(basename "$old")"
        done
fi
