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
  echo "Deploy aborted: expected the standalone BooneTools repo root $EXPECTED_ROOT but git resolved $GIT_ROOT." >&2
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
    echo "Expected '$EXPECTED_REMOTE_HTTPS' (or its SSH equivalent)." >&2
    return 1
    ;;
esac

CURRENT_BRANCH="$(git -C "$GIT_ROOT" branch --show-current 2>/dev/null || true)"
CURRENT_HEAD="$(git -C "$GIT_ROOT" rev-parse HEAD 2>/dev/null || true)"
WORKTREE_STATUS="$(git -C "$GIT_ROOT" status --short --untracked-files=normal 2>/dev/null || true)"
ALLOW_UNVERIFIED_SOURCE="${BOONETOOLS_ALLOW_UNVERIFIED_SOURCE:-false}"
SKIP_CI_CHECK="${BOONETOOLS_SKIP_CI_CHECK:-false}"

echo "==> Deploy source repo verified: ${CURRENT_BRANCH:-detached}@${CURRENT_HEAD:0:12}"
echo "==> Origin: $ORIGIN_URL"

SOURCE_VERIFIED=true
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Deploy source is not the main branch: ${CURRENT_BRANCH:-detached}" >&2
  SOURCE_VERIFIED=false
fi
if [[ -n "$WORKTREE_STATUS" ]]; then
  echo "Deploy source contains local changes:" >&2
  echo "$WORKTREE_STATUS" >&2
  SOURCE_VERIFIED=false
fi

REMOTE_MAIN_HEAD="$(git ls-remote "$ORIGIN_URL" refs/heads/main 2>/dev/null | awk 'NR == 1 { print $1 }')"
if [[ -z "$REMOTE_MAIN_HEAD" ]]; then
  echo "Unable to resolve origin/main from $ORIGIN_URL." >&2
  SOURCE_VERIFIED=false
elif [[ "$CURRENT_HEAD" != "$REMOTE_MAIN_HEAD" ]]; then
  echo "Deploy source HEAD does not match origin/main ($REMOTE_MAIN_HEAD)." >&2
  SOURCE_VERIFIED=false
fi

if [[ "$SOURCE_VERIFIED" != "true" && "$ALLOW_UNVERIFIED_SOURCE" != "true" ]]; then
  echo "Deploy aborted: production releases require a clean main commit matching origin/main." >&2
  echo "For an audited emergency release only, set BOONETOOLS_ALLOW_UNVERIFIED_SOURCE=true." >&2
  return 1
fi

if [[ "$SOURCE_VERIFIED" == "true" && "$SKIP_CI_CHECK" != "true" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "Deploy aborted: GitHub CLI is required to verify the CI result for $CURRENT_HEAD." >&2
    echo "Set BOONETOOLS_SKIP_CI_CHECK=true only after independently verifying CI." >&2
    return 1
  fi

  CI_CONCLUSION="$(
    gh api "repos/erebuskaimoros/boonetools/commits/$CURRENT_HEAD/check-runs?per_page=100" \
      --jq '[.check_runs[] | select(.name == "verify")] | sort_by(.completed_at) | last | .conclusion // ""' \
      2>/dev/null || true
  )"
  if [[ "$CI_CONCLUSION" != "success" ]]; then
    echo "Deploy aborted: the latest GitHub Actions 'verify' check is '${CI_CONCLUSION:-missing}', not successful." >&2
    return 1
  fi
elif [[ "$SOURCE_VERIFIED" == "true" ]]; then
  echo "==> WARNING: CI verification was explicitly skipped." >&2
fi

if [[ "$SOURCE_VERIFIED" == "true" ]]; then
  DEPLOY_RELEASE_ID="$CURRENT_HEAD"
  DEPLOY_SOURCE_MODE=verified
else
  DEPLOY_RELEASE_ID="${CURRENT_HEAD:0:12}-unverified-$(date -u +%Y%m%dT%H%M%SZ)"
  DEPLOY_SOURCE_MODE=unverified
  echo "==> WARNING: deploying an explicitly authorized unverified source tree." >&2
fi

export BOONETOOLS_CANONICAL_ROOT="$EXPECTED_ROOT"
export BOONETOOLS_CANONICAL_ORIGIN="$ORIGIN_URL"
export BOONETOOLS_CANONICAL_GIT_ROOT="$GIT_ROOT"
export BOONETOOLS_DEPLOY_COMMIT="$CURRENT_HEAD"
export BOONETOOLS_DEPLOY_RELEASE_ID="$DEPLOY_RELEASE_ID"
export BOONETOOLS_DEPLOY_SOURCE_MODE="$DEPLOY_SOURCE_MODE"
