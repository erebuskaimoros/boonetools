#!/usr/bin/env bash
# Source with one explicit commit/ref. Local branch and worktree state do not
# matter: deploy entrypoints package only this verified Git object.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "This script must be sourced by a deploy script." >&2
  exit 1
fi

if [[ "$#" -ne 1 || "$1" == -* ]]; then
  echo "Usage: npm run boonetools:deploy:{backend,frontend} -- COMMIT_OR_REF" >&2
  return 2
fi
EXPECTED_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
GIT_ROOT="$(git -C "$EXPECTED_ROOT" rev-parse --show-toplevel)"
[[ "$(cd "$GIT_ROOT" && pwd -P)" == "$EXPECTED_ROOT" ]] || {
  echo "Deploy aborted: not a standalone BooneTools checkout." >&2
  return 1
}
ORIGIN_URL="$(git -C "$GIT_ROOT" remote get-url origin)"
case "$ORIGIN_URL" in
  https://github.com/erebuskaimoros/boonetools.git|git@github.com:erebuskaimoros/boonetools.git) ;;
  *) echo "Deploy aborted: origin is not the canonical BooneTools remote." >&2; return 1 ;;
esac

# Fetch without checking out, stashing, resetting, or rewriting the local branch.
git -C "$GIT_ROOT" fetch --quiet origin main || return 1
COMMIT="$(git -C "$GIT_ROOT" rev-parse --verify "$1^{commit}")" || return 1
git -C "$GIT_ROOT" merge-base --is-ancestor "$COMMIT" FETCH_HEAD || {
  echo "Deploy aborted: $COMMIT is not on production main." >&2
  return 1
}
command -v gh >/dev/null 2>&1 || {
  echo "Deploy aborted: GitHub CLI is required to verify CI." >&2
  return 1
}
CI_CONCLUSION="$(gh api "repos/erebuskaimoros/boonetools/commits/$COMMIT/check-runs?per_page=100" \
  --jq '[.check_runs[] | select(.name == "verify" and .app.slug == "github-actions")] | sort_by(.started_at) | last | .conclusion // ""')" || return 1
[[ "$CI_CONCLUSION" == success ]] || {
  echo "Deploy aborted: latest GitHub Actions verify check for $COMMIT is '${CI_CONCLUSION:-missing}', not successful." >&2
  return 1
}

export BOONETOOLS_CANONICAL_ROOT="$EXPECTED_ROOT"
export BOONETOOLS_DEPLOY_COMMIT="$COMMIT"
export BOONETOOLS_DEPLOY_RELEASE_ID="$COMMIT"
echo "==> Deploying CI-passing production commit $COMMIT (local edits excluded)"
