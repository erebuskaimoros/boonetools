#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "This script must be sourced by a deploy script." >&2
  exit 1
fi

EXPECTED_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_REMOTE_HTTPS="https://github.com/erebuskaimoros/boonetools.git"
EXPECTED_REMOTE_SSH="git@github.com:erebuskaimoros/boonetools.git"

if ! GIT_ROOT="$(git -C "$EXPECTED_ROOT" rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Deploy aborted: $EXPECTED_ROOT is not inside a git checkout." >&2
  return 1
fi

if [[ "$GIT_ROOT" != "$EXPECTED_ROOT" ]]; then
  echo "Deploy aborted: expected canonical BooneTools repo root $EXPECTED_ROOT but git resolved $GIT_ROOT." >&2
  return 1
fi

if ! ORIGIN_URL="$(git -C "$EXPECTED_ROOT" remote get-url origin 2>/dev/null)"; then
  echo "Deploy aborted: repo at $EXPECTED_ROOT has no origin remote configured." >&2
  return 1
fi

case "$ORIGIN_URL" in
  "$EXPECTED_REMOTE_HTTPS"|"$EXPECTED_REMOTE_SSH")
    ;;
  *)
    echo "Deploy aborted: origin '$ORIGIN_URL' is not the canonical BooneTools remote." >&2
    echo "Expected '$EXPECTED_REMOTE_HTTPS' (or SSH equivalent)." >&2
    return 1
    ;;
esac

CURRENT_BRANCH="$(git -C "$EXPECTED_ROOT" branch --show-current 2>/dev/null || true)"
CURRENT_HEAD="$(git -C "$EXPECTED_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
WORKTREE_STATUS="$(git -C "$EXPECTED_ROOT" status --short --untracked-files=normal 2>/dev/null || true)"

echo "==> Deploy source repo verified: ${CURRENT_BRANCH:-detached}@${CURRENT_HEAD:-unknown}"
echo "==> Origin: $ORIGIN_URL"
if [[ -n "$WORKTREE_STATUS" ]]; then
  echo "==> Working tree has local changes:"
  echo "$WORKTREE_STATUS"
fi

export BOONETOOLS_CANONICAL_ROOT="$EXPECTED_ROOT"
export BOONETOOLS_CANONICAL_ORIGIN="$ORIGIN_URL"
