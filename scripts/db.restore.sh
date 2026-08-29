#!/usr/bin/env bash

set -euo pipefail

DUMP_FILE="./database/cp.dump"

pg_restore \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --create \
  --dbname=postgres \
  "$DUMP_FILE"

echo "Restore completed."