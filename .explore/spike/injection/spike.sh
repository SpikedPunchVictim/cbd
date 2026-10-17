#!/bin/sh
cd /tmp/cbd-inject || exit 1
rm -rf run && mkdir -p run

# The developer's entire change: one environment variable. The server below has no
# CBD import, no wrapper, no flag of its own.
CBD_SOCKET_DIR=/tmp/cbd-inject/run \
SPAWN_WORKER=1 \
NODE_OPTIONS="--import /tmp/cbd-inject/instr.mjs" \
  node server.mjs > server.log 2>&1 &
SERVER=$!

sleep 2

echo "=== what the server printed ==="
cat server.log
echo
echo "=== what the collector does ==="
node client.mjs /tmp/cbd-inject/run

kill "$SERVER" 2>/dev/null
pkill -f "cbd-inject/instr.mjs" 2>/dev/null
pkill -f "cbd-inject/server.mjs" 2>/dev/null
exit 0
