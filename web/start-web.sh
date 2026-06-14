#!/usr/bin/env bash
# systemd용 대시보드 기동: 빌드된 dist를 vite preview로 서빙(127.0.0.1:5174).
# 코드 변경 후에는 `npm run build` 다시 한 뒤 서비스 재시작.
set -e
cd /home/ubuntu/projects/gyeongmae-agent/web
NODE=/home/ubuntu/.local/bin/node
exec "$NODE" node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5174
