#!/usr/bin/env bash
#
# apply-patches.sh — Apply all ChipOS brand patches from build/chipos-patches/.
#
# Usage:
#   ./scripts/apply-patches.sh [--dry-run] [--commit]
#
# Options:
#   --dry-run   Check patches without applying
#   --commit    Create a git commit after each patch

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

DRY_RUN=false
AUTO_COMMIT=false

for arg in "$@"; do
	case "${arg}" in
		--dry-run)  DRY_RUN=true ;;
		--commit)   AUTO_COMMIT=true ;;
		*)          die "Unknown option: ${arg}" ;;
	esac
done

cd "${REPO_ROOT}"

if [[ ! -d "${PATCHES_DIR}" ]]; then
	die "Patches directory not found: ${PATCHES_DIR}"
fi

PATCHES=("${PATCHES_DIR}"/*.patch)

if [[ ${#PATCHES[@]} -eq 0 ]] || [[ ! -f "${PATCHES[0]}" ]]; then
	log "No .patch files found in ${PATCHES_DIR}"
	exit 0
fi

log "Found ${#PATCHES[@]} patch(es) in ${PATCHES_DIR}"

APPLIED=0
SKIPPED=0
FAILED=0

for patch_file in "${PATCHES[@]}"; do
	patch_name="$(basename "${patch_file}")"

	if ! git apply --check "${patch_file}" 2>/dev/null; then
		if git apply --check --reverse "${patch_file}" 2>/dev/null; then
			ok "Already applied: ${patch_name}"
			((SKIPPED++))
			continue
		fi
		err "Cannot apply: ${patch_name}"
		if ${DRY_RUN}; then
			warn "  (dry-run) Would fail — showing reject preview:"
			git apply --stat "${patch_file}" 2>/dev/null || true
		fi
		((FAILED++))
		continue
	fi

	if ${DRY_RUN}; then
		ok "(dry-run) Would apply: ${patch_name}"
		git apply --stat "${patch_file}"
		((APPLIED++))
		continue
	fi

	git apply "${patch_file}"
	ok "Applied: ${patch_name}"

	if ${AUTO_COMMIT}; then
		git add -A
		git commit -m "chipos: apply brand patch ${patch_name}" --no-verify
		ok "Committed: ${patch_name}"
	fi

	((APPLIED++))
done

echo ""
printf "${BOLD}Results:${RESET} applied=${APPLIED}  skipped=${SKIPPED}  failed=${FAILED}\n"

if [[ ${FAILED} -gt 0 ]]; then
	warn "Some patches failed. Resolve conflicts manually or regenerate patches."
	exit 1
fi

if ! ${DRY_RUN} && ! ${AUTO_COMMIT} && [[ ${APPLIED} -gt 0 ]]; then
	warn "Patches applied but NOT committed. Review changes and commit when ready."
fi
