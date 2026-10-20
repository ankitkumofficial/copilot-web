#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This uninstaller is for macOS." >&2
  exit 1
fi

BIN_DIR="$HOME/.local/bin"
CPW_BIN="$BIN_DIR/cpw"
LABEL="com.github.copilot-web"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE="gui/$(id -u)/$LABEL"
CPW_MARKER="# Managed by the copilot-web macOS cpw installer."
PLIST_MARKER="Managed by the copilot-web macOS installer."
PATH_START="# >>> copilot-web cpw installer >>>"
PATH_END="# <<< copilot-web cpw installer <<<"
PROFILE_TMP=""

cleanup() {
  [[ -z "$PROFILE_TMP" ]] || rm -f "$PROFILE_TMP"
}
trap cleanup EXIT

if [[ -e "$CPW_BIN" || -L "$CPW_BIN" ]]; then
  if [[ -L "$CPW_BIN" ]] || ! grep -Fq "$CPW_MARKER" "$CPW_BIN"; then
    echo "Refusing to remove an unmanaged command: $CPW_BIN" >&2
    exit 1
  fi
fi

if [[ -e "$PLIST" || -L "$PLIST" ]]; then
  if [[ -L "$PLIST" ]] || ! grep -Fq "$PLIST_MARKER" "$PLIST"; then
    echo "Refusing to remove an unmanaged LaunchAgent plist: $PLIST" >&2
    exit 1
  fi
fi

if [[ -f "$PLIST" ]] && launchctl print "$SERVICE" >/dev/null 2>&1; then
  launchctl bootout "$SERVICE"
fi

if [[ -f "$PLIST" ]]; then
  rm "$PLIST"
  echo "Removed LaunchAgent plist."
fi

if [[ -f "$CPW_BIN" ]]; then
  rm "$CPW_BIN"
  echo "Removed cpw command."
fi

profile=""
case "${SHELL:-}" in
  zsh|*/zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash|*/bash) profile="$HOME/.bash_profile" ;;
esac

if [[ -n "$profile" && -f "$profile" ]] && grep -Fq "$PATH_START" "$profile"; then
  PROFILE_TMP="$(mktemp "${profile}.cpw.XXXXXX")"
  if awk -v start="$PATH_START" -v end="$PATH_END" '
    $0 == start {
      if (inside || seen) {
        invalid = 1
        exit
      }
      inside = 1
      seen = 1
      next
    }
    $0 == end {
      if (!inside) {
        invalid = 1
        exit
      }
      inside = 0
      next
    }
    !inside { print }
    END {
      if (invalid || inside || !seen) {
        exit 2
      }
    }
  ' "$profile" > "$PROFILE_TMP"; then
    if cat "$PROFILE_TMP" > "$profile"; then
      echo "Removed cpw PATH entry from $profile."
    else
      echo "Could not update $profile; remove the copilot-web PATH block manually." >&2
    fi
  else
    echo "Could not safely identify the cpw PATH block in $profile; leaving it unchanged." >&2
  fi
  rm -f "$PROFILE_TMP"
  PROFILE_TMP=""
fi

echo "Uninstallation complete. The copilot-web checkout and logs were left untouched."
