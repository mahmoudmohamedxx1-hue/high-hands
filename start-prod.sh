#!/usr/bin/env bash
# Start World Monitor production stack (self-hosted sandbox layout):
#   - vite preview  :3002  → static production bundle (dist/)
#   - vite dev      :3001  → API middlewares (sebuf RPCs, dev-only routers)
# The Next.js gateway (:3000, /home/z/my-project) proxies:
#   /api/* /rss/* /widget-agent* → :3001, everything else → :3002.
#
# Usage:  bash /home/z/worldmonitor/start-prod.sh
# Rebuild: pkill -f vite first (frees RAM), then:
#          NODE_OPTIONS=--max-old-space-size=2560 npx vite build
#          && bash /home/z/worldmonitor/start-prod.sh

set -euo pipefail
cd "$(dirname "$0")"

# Vite dev defaults to :3000 which the Next gateway owns.
export DEV_PORT=3001
# Keep the dev server from trying to spawn a browser.
export BROWSER=none
# Small-memory guard for the dev server's dep optimizer.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"

# --- stop any previous instances -------------------------------------------
pkill -f "vite preview" 2>/dev/null || true
pkill -f "vite dev" 2>/dev/null || true
pkill -f "node.*worldmonitor.*vite" 2>/dev/null || true
sleep 1

# --- self-heal: preview serves / from the dashboard shell ------------------
if [ -f dist/dashboard.html ]; then
  cp -f dist/dashboard.html dist/index.html
fi
if [ ! -f dist/index.html ]; then
  echo "ERROR: dist/index.html missing — run the build first (see header comment)." >&2
  exit 1
fi

# --- start both servers, orphaned to PID 1 so they survive this shell ------
setsid --fork npm run dev >/tmp/wm-dev.log 2>&1 < /dev/null
setsid --fork npx vite preview --port 3002 --strictPort >/tmp/wm-preview.log 2>&1 < /dev/null

# --- wait for readiness -----------------------------------------------------
for port in 3001 3002; do
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "http://localhost:${port}/"; then
      echo "port ${port}: up"
      break
    fi
    sleep 1
    if [ "$i" = "60" ]; then
      echo "WARNING: port ${port} not responding after 60s — check /tmp/wm-dev.log /tmp/wm-preview.log" >&2
    fi
  done
done

echo "HIGH-HANDS stack:"
echo "  bundle : http://localhost:3002  (vite preview, dist/)"
echo "  api    : http://localhost:3001  (vite dev middlewares)"
echo "  user   : via Next gateway :3000 → /  (src/proxy.ts routes)"
