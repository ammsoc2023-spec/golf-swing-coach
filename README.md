# Golf Swing Coach
Node/Express app. `./start.sh` restarts the server (port 8787, override with PORT) and tries a Cloudflare quick tunnel.
Set the key: `echo 'GEMINI_API_KEY=...' > .env && chmod 600 .env && ./start.sh` (never logged).
Model: gemini-3.8-flash, falls back to gemini-flash-latest then gemini-2.5-flash; override with GEMINI_MODEL.
Logs: logs/server.log, logs/tunnel.log. Public URL (if tunnel connects): public_url.txt.
