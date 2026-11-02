#!/usr/bin/env bash
# Restarts the Golf Swing Coach server and its Cloudflare quick tunnel.
# Optional: put GEMINI_API_KEY=... (and PORT / GEMINI_MODEL) in ./.env — it is never printed.
set -u
cd "$(dirname "$0")"
APP_DIR="$(pwd)"
mkdir -p logs uploads
if [ -f .env ]; then set -a; . ./.env; set +a; fi
PORT="${PORT:-8787}"; export PORT

stop_pid() { [ -f "$1" ] && kill "$(cat "$1")" 2>/dev/null; rm -f "$1"; }
stop_pid logs/server.pid
stop_pid logs/tunnel.pid
pkill -f "node $APP_DIR/server.js" 2>/dev/null
pkill -f "$APP_DIR/bin/cloudflared tunnel" 2>/dev/null
sleep 1
rm -f uploads/* 2>/dev/null

nohup setsid node "$APP_DIR/server.js" >> logs/server.log 2>&1 < /dev/null &
echo $! > logs/server.pid

for i in $(seq 1 20); do curl -fs "http://localhost:$PORT/healthz" >/dev/null && break; sleep 0.5; done
curl -fs "http://localhost:$PORT/healthz" >/dev/null && echo "Server up: http://localhost:$PORT" || { echo "Server failed to start — see logs/server.log"; exit 1; }

CF="$APP_DIR/bin/cloudflared"; command -v cloudflared >/dev/null && [ ! -x "$CF" ] && CF="$(command -v cloudflared)"
: > logs/tunnel.log
nohup setsid "$CF" tunnel --no-autoupdate --protocol http2 --url "http://localhost:$PORT" >> logs/tunnel.log 2>&1 < /dev/null &
echo $! > logs/tunnel.pid

URL=""; OK=""
for i in $(seq 1 30); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log | head -1)
  grep -q "Registered tunnel connection" logs/tunnel.log && OK=1 && break
  sleep 1
done
if [ -n "$URL" ] && [ -n "$OK" ]; then echo "$URL" > public_url.txt; echo "Public URL: $URL"
else
  rm -f public_url.txt
  echo "Public tunnel could NOT connect (this network blocks Cloudflare's tunnel port 7844 — see logs/tunnel.log)."
  echo "Stopping tunnel; app is still available locally at http://localhost:$PORT"
  stop_pid logs/tunnel.pid
fi
