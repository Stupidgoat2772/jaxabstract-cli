#!/usr/bin/env bash
set -euo pipefail

APP_ID="local.kumo.jaxabstract-output"
APP_NAME="Jaxabstract Output"
BIN_NAME="jaxabstract-output"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="${JAXABSTRACT_BIN_DIR:-${HOME}/.local/bin}"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
APPLICATIONS_DIR="${JAXABSTRACT_APPLICATIONS_DIR:-${DATA_HOME}/applications}"
LAUNCHER="${BIN_DIR}/${BIN_NAME}"
DESKTOP_FILE="${APPLICATIONS_DIR}/${APP_ID}.desktop"
ICON_FILE="${APP_DIR}/src-tauri/icons/icon.png"
USER_CONFIG_DIR="${CONFIG_HOME}/jaxabstract"
USER_OUTPUT_CONFIG="${USER_CONFIG_DIR}/output.config.json"
USER_MEDIA_CONFIG="${USER_CONFIG_DIR}/media.json"
DEFAULT_OUTPUT_CONFIG="${APP_DIR}/web/output.config.json"
DEFAULT_MEDIA_CONFIG="${APP_DIR}/web/media/media.json"

RUN_NPM_INSTALL=1
INSTALL_DESKTOP=1
CHECK_DEPS=1
PACK="fresh"
RICE_PACK_URL=""
RESET_CONFIG=0
UNINSTALL=0

usage() {
  cat <<EOF
usage: npm run install:linux -- [options]
       scripts/install-linux.sh [options]

Installs jaxabstract-output for the current Linux user.

options:
  --bin-dir DIR          install command launcher here (default: ~/.local/bin)
  --with-rice URL        install a remote rice/media pack JSON as the active media pack
  --fresh                install clean starter config with no media pack (default)
  --reset-config         overwrite existing jaxabstract user config for the chosen pack
  --no-desktop          skip the .desktop application launcher
  --skip-npm-install    do not run npm install before installing launchers
  --skip-dep-check      do not print dependency warnings
  --uninstall           remove installed launcher and desktop entry
  -h, --help            print this help

environment:
  JAXABSTRACT_BIN_DIR           overrides the command launcher directory
  JAXABSTRACT_APPLICATIONS_DIR  overrides the .desktop entry directory
EOF
}

warn() {
  printf 'jaxabstract install: warning: %s\n' "$*" >&2
}

die() {
  printf 'jaxabstract install: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir)
      [ "$#" -ge 2 ] || die "--bin-dir needs a value"
      BIN_DIR="$2"
      LAUNCHER="${BIN_DIR}/${BIN_NAME}"
      shift 2
      ;;
    --no-desktop)
      INSTALL_DESKTOP=0
      shift
      ;;
    --with-rice)
      [ "$#" -ge 2 ] || die "--with-rice needs a URL"
      case "$2" in
        -*) die "--with-rice needs a URL" ;;
      esac
      PACK="rice"
      RICE_PACK_URL="$2"
      shift 2
      ;;
    --fresh)
      PACK="fresh"
      shift
      ;;
    --reset-config)
      RESET_CONFIG=1
      shift
      ;;
    --skip-npm-install)
      RUN_NPM_INSTALL=0
      shift
      ;;
    --skip-dep-check)
      CHECK_DEPS=0
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

check_command() {
  command -v "$1" >/dev/null 2>&1 || warn "$1 not found on PATH"
}

check_pkg_config() {
  if ! command -v pkg-config >/dev/null 2>&1; then
    warn "pkg-config not found; Tauri builds usually need it"
    return
  fi

  if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null && ! pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
    warn "WebKitGTK development package not found by pkg-config"
  fi

  if ! pkg-config --exists gtk+-3.0 2>/dev/null; then
    warn "GTK 3 development package not found by pkg-config"
  fi
}

download_file() {
  local url="$1"
  local out="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fL "$url" -o "$out"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -O "$out" "$url"
    return
  fi

  die "curl or wget is required to download optional packs"
}

install_rice_pack() {
  local tmp
  tmp="$(mktemp)"

  printf 'downloading rice pack: %s\n' "$RICE_PACK_URL"
  download_file "$RICE_PACK_URL" "$tmp"

  node - "$tmp" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const pack = JSON.parse(fs.readFileSync(path, 'utf8'));
if (!Array.isArray(pack.media)) throw new Error('rice pack media must be an array');
if (pack.profiles != null && typeof pack.profiles !== 'object') throw new Error('rice pack profiles must be an object');
if (pack.default_profile && !pack.profiles?.[pack.default_profile]) {
  throw new Error(`rice pack default_profile missing from profiles: ${pack.default_profile}`);
}
NODE

  cp "$tmp" "$USER_MEDIA_CONFIG"
  rm -f "$tmp"
}

preflight() {
  check_command node
  check_command npm
  check_command cargo
  check_command pactl
  check_command parec
  check_pkg_config
}

write_launcher() {
  mkdir -p "$BIN_DIR"

  cat >"$LAUNCHER" <<EOF
#!/usr/bin/env bash
set -euo pipefail

APP_DIR='${APP_DIR}'
cd "\$APP_DIR"

if [ -x "\$APP_DIR/src-tauri/target/release/jaxabstract-output" ]; then
  exec "\$APP_DIR/src-tauri/target/release/jaxabstract-output" "\$@"
fi

exec npm run output -- "\$@"
EOF

  chmod +x "$LAUNCHER"
}

write_desktop_entry() {
  [ "$INSTALL_DESKTOP" -eq 1 ] || return 0
  mkdir -p "$APPLICATIONS_DIR"

  cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=${APP_NAME}
GenericName=Audio-reactive terminal visualizer
Comment=MilkDrop-style audio-reactive terminal shell
Exec=${LAUNCHER}
Icon=${ICON_FILE}
Terminal=false
Categories=Utility;AudioVideo;
StartupNotify=true
StartupWMClass=jaxabstract output
EOF

  chmod 0644 "$DESKTOP_FILE"

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
  fi
}

write_user_config() {
  mkdir -p "$USER_CONFIG_DIR"

  if [ "$RESET_CONFIG" -eq 1 ] || [ ! -f "$USER_OUTPUT_CONFIG" ]; then
    cp "$DEFAULT_OUTPUT_CONFIG" "$USER_OUTPUT_CONFIG"
  fi

  case "$PACK" in
    rice)
      install_rice_pack
      node - "$USER_OUTPUT_CONFIG" "$USER_MEDIA_CONFIG" <<'NODE'
const fs = require('node:fs');
const configPath = process.argv[2];
const mediaPath = process.argv[3];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const media = JSON.parse(fs.readFileSync(mediaPath, 'utf8'));
const profile = media.default_profile || Object.keys(media.profiles || {})[0] || null;
config.profile = profile;
config.profiles = config.profiles || {};
if (profile) {
  config.profiles[profile] = config.profiles[profile] || {};
  config.profiles[profile].shaders = config.profiles[profile].shaders || {
    allow_random: true,
    allow: [],
    deny: [],
    favorites: {}
  };
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
NODE
      ;;
    fresh)
      if [ "$RESET_CONFIG" -eq 1 ] || [ ! -f "$USER_MEDIA_CONFIG" ]; then
        cp "$DEFAULT_MEDIA_CONFIG" "$USER_MEDIA_CONFIG"
      fi
      ;;
    *)
      die "unknown pack: $PACK"
      ;;
  esac
}

uninstall() {
  rm -f "$LAUNCHER" "$DESKTOP_FILE"
  printf 'removed: %s\n' "$LAUNCHER"
  printf 'removed: %s\n' "$DESKTOP_FILE"
}

main() {
  if [ "$UNINSTALL" -eq 1 ]; then
    uninstall
    return
  fi

  [ -f "$APP_DIR/package.json" ] || die "package.json not found in $APP_DIR"

  if [ "$CHECK_DEPS" -eq 1 ]; then
    preflight
  fi

  if [ "$RUN_NPM_INSTALL" -eq 1 ]; then
    (cd "$APP_DIR" && npm install)
  fi

  write_launcher
  write_desktop_entry
  write_user_config

  printf 'installed command: %s\n' "$LAUNCHER"
  if [ "$INSTALL_DESKTOP" -eq 1 ]; then
    printf 'installed desktop entry: %s\n' "$DESKTOP_FILE"
  fi
  printf 'config: %s\n' "$USER_OUTPUT_CONFIG"
  printf 'media config: %s\n' "$USER_MEDIA_CONFIG"
  printf 'media pack: %s\n' "$PACK"
  if [ "$PACK" = "rice" ]; then
    printf 'media pack url: %s\n' "$RICE_PACK_URL"
  fi

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) warn "${BIN_DIR} is not on PATH; add it to launch ${BIN_NAME} from a shell" ;;
  esac
}

main
