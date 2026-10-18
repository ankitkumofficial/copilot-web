#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
BIN_DIR="$HOME/.local/bin"
CPW_BIN="$BIN_DIR/cpw"
LABEL="com.github.copilot-web"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/copilot-web"
PLIST_BUDDY="/usr/libexec/PlistBuddy"
CPW_MARKER="# Managed by the copilot-web macOS cpw installer."
PLIST_MARKER="Managed by the copilot-web macOS installer."
PATH_START="# >>> copilot-web cpw installer >>>"
PATH_END="# <<< copilot-web cpw installer <<<"

if [[ ! -f "$APP_ROOT/package.json" || ! -f "$APP_ROOT/package-lock.json" ]]; then
  echo "Could not find copilot-web's package files at $APP_ROOT" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" || -z "$NPM_BIN" || ! -x "$NPM_BIN" ]]; then
  echo "Node.js and npm must be installed and available on PATH." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 24 )); then
  echo "copilot-web requires Node.js 24 or newer; found $("$NODE_BIN" --version)." >&2
  exit 1
fi

if ! command -v copilot >/dev/null 2>&1; then
  echo "GitHub Copilot CLI must be installed and available on PATH." >&2
  exit 1
fi

if [[ ! -x "$APP_ROOT/node_modules/.bin/tsc" ]]; then
  echo "Installing copilot-web dependencies from package-lock.json..."
  (cd "$APP_ROOT" && "$NPM_BIN" ci)
fi

echo "Building copilot-web..."
(cd "$APP_ROOT" && "$NPM_BIN" run build)
if [[ ! -f "$APP_ROOT/dist/server.js" ]]; then
  echo "Build completed without creating $APP_ROOT/dist/server.js" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$PLIST_DIR" "$LOG_DIR"

if [[ -e "$CPW_BIN" || -L "$CPW_BIN" ]]; then
  if [[ -L "$CPW_BIN" ]] || ! grep -Fq "$CPW_MARKER" "$CPW_BIN"; then
    echo "Refusing to replace existing command: $CPW_BIN" >&2
    echo "Move it aside or choose another installation path before retrying." >&2
    exit 1
  fi
fi

if [[ -e "$PLIST" ]] && ! grep -Fq "$PLIST_MARKER" "$PLIST"; then
  echo "Refusing to replace an unmanaged LaunchAgent plist: $PLIST" >&2
  exit 1
fi

xml_escape() {
  local value="$1"
  value="${value//&/\&amp;}"
  value="${value//</\&lt;}"
  value="${value//>/\&gt;}"
  value="${value//\"/\&quot;}"
  value="${value//\'/\&apos;}"
  printf '%s' "$value"
}

SERVICE_PATH="$BIN_DIR:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
XML_APP_ROOT="$(xml_escape "$APP_ROOT")"
XML_NODE_BIN="$(xml_escape "$NODE_BIN")"
XML_SERVER_PATH="$(xml_escape "$APP_ROOT/dist/server.js")"
XML_NPM_BIN="$(xml_escape "$NPM_BIN")"
XML_SERVICE_PATH="$(xml_escape "$SERVICE_PATH")"
XML_STDOUT_PATH="$(xml_escape "$LOG_DIR/stdout.log")"
XML_STDERR_PATH="$(xml_escape "$LOG_DIR/stderr.log")"

TMP_CPW="$(mktemp "$BIN_DIR/.cpw.XXXXXX")"
TMP_PLIST="$(mktemp "$PLIST_DIR/.$LABEL.XXXXXX")"
cleanup() {
  [[ -z "${TMP_CPW:-}" ]] || rm -f "$TMP_CPW"
  [[ -z "${TMP_PLIST:-}" ]] || rm -f "$TMP_PLIST"
}
trap cleanup EXIT

cp "$SCRIPT_DIR/cpw" "$TMP_CPW"
chmod 755 "$TMP_CPW"
mv -f "$TMP_CPW" "$CPW_BIN"
TMP_CPW=""

cat > "$TMP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- $PLIST_MARKER -->
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$XML_NODE_BIN</string>
    <string>$XML_SERVER_PATH</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$XML_APP_ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NPM_BIN</key>
    <string>$XML_NPM_BIN</string>
    <key>PATH</key>
    <string>$XML_SERVICE_PATH</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$XML_STDOUT_PATH</string>
  <key>StandardErrorPath</key>
  <string>$XML_STDERR_PATH</string>
</dict>
</plist>
EOF

plutil -lint "$TMP_PLIST"
chmod 644 "$TMP_PLIST"
mv -f "$TMP_PLIST" "$PLIST"
TMP_PLIST=""

profile=""
case "${SHELL:-}" in
  zsh|*/zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash|*/bash) profile="$HOME/.bash_profile" ;;
esac

if [[ ":${PATH:-}:" != *":$BIN_DIR:"* ]]; then
  if [[ -n "$profile" ]]; then
    mkdir -p "$(dirname "$profile")"
    if ! grep -Fq "$PATH_START" "$profile" 2>/dev/null; then
      {
        [[ ! -s "$profile" ]] || printf '\n'
        printf '%s\n' "$PATH_START" 'export PATH="$HOME/.local/bin:$PATH"' "$PATH_END"
      } >> "$profile"
      echo "Added $BIN_DIR to PATH in $profile."
    fi
  else
    echo "Add $BIN_DIR to your shell PATH to run cpw without its full path."
  fi
fi

echo "Installed cpw at $CPW_BIN"
echo "Created LaunchAgent at $PLIST"
echo "copilot-web is not started automatically. Open a new terminal, then run: cpw start"
