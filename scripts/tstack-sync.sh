#!/bin/bash
# Copy t3dotgg/tstack skills into every harness folder T3 reads. Usage: tstack-sync [--pull] [--dry-run]
# Folder roots come from the same env vars T3's server uses; export them first (see README step 2).
set -euo pipefail
SRC="${TSTACK_SRC:-$HOME/Projects/tstack}"
PULL=0; DRY=0
for a in "$@"; do case "$a" in --pull) PULL=1 ;; --dry-run) DRY=1 ;; *) echo "unknown arg: $a" >&2; exit 2 ;; esac; done
[ -d "$SRC/skills" ] || { echo "no skills at $SRC/skills; clone https://github.com/t3dotgg/tstack there" >&2; exit 1; }
[ "$PULL" = 1 ] && git -C "$SRC" pull --ff-only --quiet

TARGETS=(
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"          # Claude
  "${CODEX_HOME:-$HOME/.codex}/skills"                  # Codex
  "$HOME/.agents/skills"                                # shared: Pi, Kimi, Codex, OpenCode
  "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills"   # OpenCode
  "${KIMI_CODE_HOME:-$HOME/.kimi}/skills"               # Kimi
  "${HERMES_HOME:-$HOME/.hermes}/skills/tstack"         # Hermes (category folder)
  "${GEMINI_HOME:-$HOME/.gemini}/config/skills"         # Antigravity
)
# Pi is covered by ~/.agents/skills on purpose: a second copy in Pi's own folder causes collision warnings.

for t in "${TARGETS[@]}"; do
  if [ "$DRY" = 1 ]; then echo "would sync -> $t"; continue; fi
  mkdir -p "$t"
  for s in "$SRC"/skills/*/; do
    n=$(basename "$s")
    rm -rf "${t:?}/$n"
    cp -R "$s" "$t/$n"
  done
  echo "synced $(ls "$SRC/skills" | wc -l | tr -d ' ') skills -> $t"
done
