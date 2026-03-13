#!/usr/bin/env bash
#
# rebase-upstream.sh — Rebase the ChipOS fork onto the latest upstream VSCode tag.
#
# Usage:
#   ./scripts/rebase-upstream.sh [<upstream-tag>]
#
# If no tag is given, the latest stable release tag is auto-detected.

set -euo pipefail

# ── Colors & helpers ────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log()  { printf "${CYAN}[chipos]${RESET} %s\n" "$*"; }
ok()   { printf "${GREEN}  ✓${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}  ⚠${RESET} %s\n" "$*"; }
err()  { printf "${RED}  ✗${RESET} %s\n" "$*" >&2; }
die()  { err "$@"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCHES_DIR="${REPO_ROOT}/build/chipos-patches"
UPSTREAM_REMOTE="upstream"
UPSTREAM_REPO="https://github.com/microsoft/vscode.git"
CHIPOS_BRANCH="chipos/main"

# ── Preflight ───────────────────────────────────────────────────────────────────

cd "${REPO_ROOT}"

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
	die "Not inside a git repository. Run this from the ChipOS IDE repo root."
fi

if [[ -n "$(git status --porcelain)" ]]; then
	die "Working tree is dirty. Commit or stash changes before rebasing."
fi

# ── Ensure upstream remote ──────────────────────────────────────────────────────

if ! git remote get-url "${UPSTREAM_REMOTE}" &>/dev/null; then
	log "Adding upstream remote: ${UPSTREAM_REPO}"
	git remote add "${UPSTREAM_REMOTE}" "${UPSTREAM_REPO}"
fi

log "Fetching upstream..."
git fetch "${UPSTREAM_REMOTE}" --tags --prune
ok "Upstream fetched"

# ── Determine target tag ────────────────────────────────────────────────────────

if [[ -n "${1:-}" ]]; then
	TARGET_TAG="$1"
	if ! git rev-parse "refs/tags/${TARGET_TAG}" &>/dev/null; then
		die "Tag '${TARGET_TAG}' not found. Check available tags with: git tag -l '1.*'"
	fi
else
	TARGET_TAG="$(git tag -l '1.*' --sort=-version:refname | head -1)"
	if [[ -z "${TARGET_TAG}" ]]; then
		die "No upstream release tags found. Fetch may have failed."
	fi
fi

log "Target upstream tag: ${BOLD}${TARGET_TAG}${RESET}"

CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo 'detached')"
if [[ "${CURRENT_BRANCH}" != "${CHIPOS_BRANCH}" ]]; then
	warn "Current branch is '${CURRENT_BRANCH}', expected '${CHIPOS_BRANCH}'."
	read -rp "Continue anyway? [y/N] " confirm
	[[ "${confirm}" =~ ^[yY]$ ]] || die "Aborted."
fi

# ── Snapshot current HEAD ───────────────────────────────────────────────────────

BACKUP_BRANCH="chipos/backup-$(date +%Y%m%d-%H%M%S)"
git branch "${BACKUP_BRANCH}"
ok "Backup branch created: ${BACKUP_BRANCH}"

# ── Rebase ──────────────────────────────────────────────────────────────────────

log "Rebasing onto ${TARGET_TAG}..."

if git rebase "${TARGET_TAG}"; then
	ok "Rebase completed successfully"
else
	err "Rebase conflicts detected!"
	echo ""
	printf "${BOLD}Conflicted files:${RESET}\n"
	git diff --name-only --diff-filter=U 2>/dev/null || true
	echo ""
	printf "${YELLOW}To resolve:${RESET}\n"
	echo "  1. Fix conflicts in the listed files"
	echo "  2. git add <resolved-files>"
	echo "  3. git rebase --continue"
	echo ""
	printf "${YELLOW}To abort:${RESET}\n"
	echo "  git rebase --abort"
	echo "  git checkout ${BACKUP_BRANCH}  # restore from backup"
	exit 1
fi

# ── Re-apply ChipOS patches ────────────────────────────────────────────────────

if [[ -d "${PATCHES_DIR}" ]] && compgen -G "${PATCHES_DIR}/*.patch" >/dev/null; then
	log "Applying ChipOS brand patches..."
	PATCH_COUNT=0
	PATCH_FAIL=0

	for patch_file in "${PATCHES_DIR}"/*.patch; do
		patch_name="$(basename "${patch_file}")"
		if git apply --check "${patch_file}" 2>/dev/null; then
			git apply "${patch_file}"
			git add -A
			git commit -m "chipos: apply brand patch ${patch_name}" --no-verify
			ok "Applied: ${patch_name}"
			((PATCH_COUNT++))
		else
			warn "Patch failed to apply cleanly: ${patch_name}"
			warn "  Manual resolution needed — patch saved for reference."
			((PATCH_FAIL++))
		fi
	done

	log "Patches applied: ${PATCH_COUNT}, failed: ${PATCH_FAIL}"
else
	log "No patches found in ${PATCHES_DIR}, skipping."
fi

# ── Summary ─────────────────────────────────────────────────────────────────────

echo ""
printf "${GREEN}${BOLD}═══ Rebase Summary ═══${RESET}\n"
echo ""
printf "  Upstream tag:    ${BOLD}${TARGET_TAG}${RESET}\n"
printf "  Branch:          ${BOLD}$(git symbolic-ref --short HEAD 2>/dev/null)${RESET}\n"
printf "  Backup:          ${BOLD}${BACKUP_BRANCH}${RESET}\n"
printf "  HEAD:            ${BOLD}$(git rev-parse --short HEAD)${RESET}\n"
echo ""
printf "${YELLOW}Next steps:${RESET}\n"
echo "  1. Run:  yarn && yarn compile"
echo "  2. Test: yarn test"
echo "  3. If good:  git branch -D ${BACKUP_BRANCH}"
echo "  4. Push:  git push origin ${CHIPOS_BRANCH} --force-with-lease"
echo ""
