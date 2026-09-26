#!/usr/bin/env bash
set -euo pipefail

cd /home/ubuntu/projects/gyeongmae-agent
PHOTO_MAX="${PHOTO_BACKFILL_MAX:-50}"

exec npm run crawl -- --source=courtauction --photos-only --photo-max="$PHOTO_MAX" --max=1000
