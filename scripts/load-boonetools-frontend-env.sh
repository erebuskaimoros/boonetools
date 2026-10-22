#!/usr/bin/env bash

# Only the browser-visible STO affiliate key is loaded; never source server env files.
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
}
