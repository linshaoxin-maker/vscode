#!/usr/bin/env bash
#
# create-patch.sh — Create a brand patch from the current diff or a specific commit.
#
# Usage:
#   ./scripts/create-patch.sh <patch-name> [<commit-range>]
#
# Examples:
#   ./scripts/create-patch.sh 001-product-json          # from staged + unstaged diff
#   ./scripts/create-patch.sh 002-icons HEAD~3..HEAD    # from last 3 commits

set -euo pipefail

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

if [[ -z "${1:-}" ]]; then
	echo "Usage: $0 <patch-name> [<commit-range>]"
	echo ""
	echo "Examples:"
	echo "  $0 001-product-json"
	echo "  $0 002-icons HEAD~3..HEAD"
	exit 1
fi

PATCH_NAME="$1"
COMMIT_RANGE="${2:-}"

cd "${REPO_ROOT}"
mkdir -p "${PATCHES_DIR}"

PATCH_FILE="${PATCHES_DIR}/${PATCH_NAME}.patch"

if [[ -f "${PATCH_FILE}" ]]; then
	warn "Patch already exists: ${PATCH_FILE}"
	read -rp "Overwrite? [y/N] " confirm
	[[ "${confirm}" =~ ^[yY]$ ]] || die "Aborted."
fi

if [[ -n "${COMMIT_RANGE}" ]]; then
	log "Creating patch from commits: ${COMMIT_RANGE}"
	git diff "${COMMIT_RANGE}" > "${PATCH_FILE}"
else
	if [[ -z "$(git diff HEAD)" && -z "$(git diff --cached)" ]]; then
		die "No changes detected. Stage changes or provide a commit range."
	fi

	log "Creating patch from working tree diff..."
	{
		git diff --cached
		git diff
	} > "${PATCH_FILE}"
fi

if [[ ! -s "${PATCH_FILE}" ]]; then
	rm -f "${PATCH_FILE}"
	die "Generated patch is empty. Nothing to save."
fi

LINES="$(wc -l < "${PATCH_FILE}" | tr -d ' ')"
FILES="$(grep -c '^diff --git' "${PATCH_FILE}" || echo 0)"

ok "Patch created: ${PATCH_FILE}"
echo ""
printf "  Files changed: ${BOLD}${FILES}${RESET}\n"
printf "  Patch lines:   ${BOLD}${LINES}${RESET}\n"
echo ""

log "Verifying patch can be applied..."
if git apply --check "${PATCH_FILE}" 2>/dev/null; then
	ok "Patch verification passed"
else
	if git apply --check --reverse "${PATCH_FILE}" 2>/dev/null; then
		ok "Patch already applied to working tree (reverse-check passed)"
	else
		warn "Patch may not apply cleanly to a clean upstream checkout."
		warn "This is expected if the patch modifies ChipOS-specific files."
	fi
fi

echo ""
printf "${YELLOW}Next steps:${RESET}\n"
echo "  1. git add ${PATCH_FILE}"
echo "  2. git commit -m 'chipos: add brand patch ${PATCH_NAME}'"
echo ""
