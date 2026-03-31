#!/usr/bin/env bash
set -euo pipefail

# Deploy the rapid swap WebSocket listener to the Hetzner server.
# Usage: bash scripts/deploy-listener.sh

SERVER="root@178.156.211.181"
DEST="/var/www/rapid-swap-listener"

echo "==> Creating directory on server..."
ssh "$SERVER" "mkdir -p $DEST/node_modules"

echo "==> Syncing listener files..."
ssh "$SERVER" "mkdir -p $DEST/scripts $DEST/src/lib/rapid-swaps $DEST/src/lib/utils"
rsync -avz scripts/rapid-swap-listener.mjs "$SERVER:$DEST/scripts/"
rsync -avz src/lib/rapid-swaps/model.js "$SERVER:$DEST/src/lib/rapid-swaps/"
rsync -avz src/lib/utils/blockchain.js "$SERVER:$DEST/src/lib/utils/"

echo "==> Installing dependencies on server..."
ssh "$SERVER" "cd $DEST && npm init -y --silent 2>/dev/null && npm pkg set type=module 2>/dev/null && npm install ws @supabase/supabase-js 2>/dev/null"

echo "==> Checking .env file..."
if ssh "$SERVER" "test -f $DEST/.env"; then
  echo "    .env exists"
else
  echo "    Creating .env template — you need to fill in the values!"
  ssh "$SERVER" "cat > $DEST/.env << 'ENVEOF'
SUPABASE_URL=https://wksusryhzxheozpgghpp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
RPC_WS_URL=wss://rpc.thorchain.network/websocket
MIDGARD_DELAY_MS=5000
ENVEOF"
fi

echo "==> Installing systemd service..."
rsync -avz scripts/rapid-swap-listener.service "$SERVER:/etc/systemd/system/"
ssh "$SERVER" "systemctl daemon-reload && systemctl enable rapid-swap-listener"

echo "==> Restarting service..."
ssh "$SERVER" "systemctl restart rapid-swap-listener"

echo "==> Status:"
ssh "$SERVER" "systemctl status rapid-swap-listener --no-pager -l" || true

echo ""
echo "Done. View logs with: ssh $SERVER journalctl -u rapid-swap-listener -f"
