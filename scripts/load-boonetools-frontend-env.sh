#!/usr/bin/env bash

# Only allowlisted browser-visible settings are loaded; never source server env files.
load_boonetools_frontend_env() {
  if [[ -z "${VITE_STO_WIDGET_API_KEY:-}" ]]; then
    if ! VITE_STO_WIDGET_API_KEY="$(ssh "$SERVER" 'cat /opt/boonetools-frontend/config/sto-widget-api-key')"; then
      echo "Deploy aborted: could not load the configured STO widget key." >&2
      return 1
    fi
  fi
  if [[ -z "$VITE_STO_WIDGET_API_KEY" || "$VITE_STO_WIDGET_API_KEY" =~ [[:space:]] ]]; then
    echo "Deploy aborted: the STO widget key is empty or contains whitespace." >&2
    return 1
  fi
  export VITE_STO_WIDGET_API_KEY

  # An unset override uses the server setting. An explicit empty override disables
  # WalletConnect, as does an absent file on servers that have not configured it.
  if [[ ! ${VITE_WALLETCONNECT_PROJECT_ID+x} ]]; then
    if ! VITE_WALLETCONNECT_PROJECT_ID="$(ssh "$SERVER" 'if [ -f /opt/boonetools-frontend/config/walletconnect-project-id ]; then cat /opt/boonetools-frontend/config/walletconnect-project-id; fi')"; then
      echo "Deploy aborted: could not load WalletConnect configuration." >&2
      return 1
    fi
  fi
  if [[ -n "$VITE_WALLETCONNECT_PROJECT_ID" && ! "$VITE_WALLETCONNECT_PROJECT_ID" =~ ^[a-fA-F0-9]{32}$ ]]; then
    echo "Deploy aborted: the WalletConnect project ID must contain 32 hexadecimal characters." >&2
    return 1
  fi
  export VITE_WALLETCONNECT_PROJECT_ID
}
