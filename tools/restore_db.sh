#!/bin/sh
# Restore the database from a dump made by tools/backup_db.sh.
#
#     docker compose exec db-backup /tools/restore_db.sh            # newest
#     docker compose exec db-backup /tools/restore_db.sh dofus-20260804-120000Z.dump
#     docker compose exec db-backup /tools/restore_db.sh --list
#
# THIS REPLACES THE CURRENT DATABASE. Every table the dump contains is dropped
# and recreated, so anything captured since that dump is gone. It asks first
# unless FORCE=1.

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
PGHOST="${PGHOST:-db}"
PGUSER="${PGUSER:-dofus}"
PGDATABASE="${PGDATABASE:-dofus}"
export PGHOST PGUSER PGDATABASE

list() {
    ls -1t "$BACKUP_DIR"/dofus-*.dump 2>/dev/null || {
        echo "no dumps in $BACKUP_DIR" >&2
        exit 1
    }
}

if [ "${1:-}" = "--list" ]; then
    ls -lht "$BACKUP_DIR"/dofus-*.dump 2>/dev/null || echo "no dumps in $BACKUP_DIR"
    exit 0
fi

if [ -n "${1:-}" ]; then
    case "$1" in
        /*) dump="$1" ;;
        *) dump="$BACKUP_DIR/$1" ;;
    esac
else
    dump=$(list | head -n 1)
fi

[ -f "$dump" ] || { echo "no such dump: $dump" >&2; exit 1; }
pg_restore -l "$dump" >/dev/null 2>&1 || { echo "unreadable dump: $dump" >&2; exit 1; }

echo "restore   $dump"
echo "into      $PGDATABASE on $PGHOST"
echo
echo "Current contents will be DROPPED. Anything captured since this dump is lost."

if [ "${FORCE:-0}" != "1" ]; then
    printf 'Type the database name (%s) to confirm: ' "$PGDATABASE"
    read -r answer
    [ "$answer" = "$PGDATABASE" ] || { echo "aborted"; exit 1; }
fi

# --clean --if-exists drops each object before recreating it, so this works
# against a database that init.sql already populated -- which is every case,
# since the postgres entrypoint runs init.sql before anything can restore.
#
# Exit status is deliberately not fatal: --clean emits errors for objects that
# were not there to drop, which is normal on a fresh volume. The row counts
# below are the real check.
pg_restore --clean --if-exists --no-owner --no-privileges -d "$PGDATABASE" "$dump" || true

echo
echo "restored:"
psql -d "$PGDATABASE" -tAc "
SELECT '  '||relname||' '||n_live_tup
  FROM pg_stat_user_tables WHERE n_live_tup > 0
 ORDER BY n_live_tup DESC LIMIT 12"
