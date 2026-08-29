#!/usr/bin/env bash

set -euo pipefail

DB_NAME="cp"
BACKUP_DIR="./database"

mkdir -p "$BACKUP_DIR"

BACKUP_FILE="$BACKUP_DIR/${DB_NAME}.dump"

pg_dump \
  -Fc \
  -f "$BACKUP_FILE" \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --create \
  "$DB_NAME"

echo "Backup created: $BACKUP_FILE"