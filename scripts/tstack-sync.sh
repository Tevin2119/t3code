#!/bin/bash
# Copy t3dotgg/tstack skills into every harness folder T3 reads.
# Usage: tstack-sync [--pull] [--dry-run] [--rename old=new ...]
# Folder roots come from the same env vars T3's server uses; export them first (see README step 2).
#
# Each copied folder gets a .tstack marker. A folder with a skill's name but no marker is someone
# else's skill: it is skipped, never replaced. If it holds exactly what tstack would copy (an
# install from before markers), it is adopted. Use --rename to install a clashing skill under
# another name, e.g. --rename council=tstack-council (renames the folder and its `name:` line).
set -euo pipefail
SRC="${TSTACK_SRC:-$HOME/Projects/tstack}"
PULL=0; DRY=0; RENAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pull) PULL=1 ;;
    --dry-run) DRY=1 ;;
    --rename) shift; [[ "${1:-}" == ?*=?* ]] || { echo "--rename needs old=new" >&2; exit 2; }; RENAMES+=("$1") ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -d "$SRC/skills" ] || { echo "no skills at $SRC/skills; clone https://github.com/t3dotgg/tstack there" >&2; exit 1; }
[ "$PULL" = 1 ] && git -C "$SRC" pull --ff-only --quiet
rev=$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)

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

# Stage what gets copied: the skills, renamed where asked.
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
cp -R "$SRC/skills/." "$stage/"
for r in "${RENAMES[@]}"; do
  old="${r%%=*}"; new="${r#*=}"
  [ -d "$stage/$old" ] || { echo "--rename: tstack has no skill named $old" >&2; exit 2; }
  mv "$stage/$old" "$stage/$new"
  sed -i.bak -e "s/^name: $old\$/name: $new/" "$stage/$new/SKILL.md" && rm -f "$stage/$new/SKILL.md.bak"
done

for t in "${TARGETS[@]}"; do
  if [ "$DRY" = 1 ]; then echo "would sync -> $t"; fi
  n_done=0
  for s in "$stage"/*/; do
    n=$(basename "$s"); dest="$t/$n"
    if [ -e "$dest" ] && [ ! -f "$dest/.tstack" ]; then
      if diff -rq "$s" "$dest" >/dev/null 2>&1; then
        [ "$DRY" = 1 ] || printf 'tstack %s\n' "$rev" > "$dest/.tstack"
        echo "adopted $dest (same as tstack's copy)"
      else
        echo "SKIP $dest: a skill named $n exists and was not installed by tstack. Ask its owner, or use --rename $n=tstack-$n" >&2
        continue
      fi
    fi
    [ "$DRY" = 1 ] && continue
    mkdir -p "$t"
    rm -rf "${dest:?}"
    cp -R "$s" "$dest"
    printf 'tstack %s\n' "$rev" > "$dest/.tstack"
    n_done=$((n_done + 1))
  done
  [ "$DRY" = 1 ] || echo "synced $n_done skills -> $t"
done
