#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$SCRIPT_DIR/web"
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/jaxabstract-bg"
PORT="${JAXABSTRACT_PORT:-8767}"
TARGET_WM_CLASS="${JAXABSTRACT_TARGET_WM_CLASS:-antigravity}"
URL="http://127.0.0.1:${PORT}/index.html"
ACTIVE_FILE="$STATE_DIR/active"
OPACITY_FILE="$STATE_DIR/opacity"
LOOP_PID_FILE="$STATE_DIR/opacity-loop.pid"
TERMINAL_LOG="$STATE_DIR/kitty.log"

usage() {
  cat <<'EOF'
usage: jaxabstract-bg.sh <command> [opacity]

commands:
  run [opacity]     start jaxabstract in foreground, restore on exit
  start [opacity]   start jaxabstract server, open browser, and enable Tripwire refresh
  terminal [opacity] [cmd...]
                    start jaxabstract and open a transparent kitty terminal
  stop              stop server, disable Tripwire refresh, and restore all window opacity
  on [opacity]      apply transparency once
  off               restore all window opacity once
  status            print current GNOME window actor opacity state
  server-status     print RUNNING when the local web server is alive
  policy-install    install GNOME Shell event policy for target opacity
  policy-status     print OK when GNOME Shell opacity policy is installed
  policy-remove     remove GNOME Shell opacity policy and restore opacity

opacity may be 0.0-1.0 or 0-255. Default: 0.82.
Default target wm_class: antigravity. Override with JAXABSTRACT_TARGET_WM_CLASS.
Requires the enabled claw-shell-bridge GNOME extension.
EOF
}

die() {
  printf 'jaxabstract-bg: %s\n' "$*" >&2
  exit 1
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

normalize_opacity() {
  local input="${1:-0.82}"
  awk -v v="$input" 'BEGIN {
    if (v == "") v = 0.82
    if (v <= 1) v = int((v * 255) + 0.5)
    else v = int(v + 0.5)
    if (v < 0) v = 0
    if (v > 255) v = 255
    print v
  }'
}

normalize_alpha() {
  local input="${1:-0.72}"
  awk -v v="$input" 'BEGIN {
    if (v == "") v = 0.72
    if (v > 1) v = v / 255
    if (v < 0) v = 0
    if (v > 1) v = 1
    printf "%.3f\n", v
  }'
}

shell_dest() {
  gdbus call \
    --session \
    --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.GetNameOwner org.gnome.Shell |
    sed -n "s/.*'\([^']*\)'.*/\1/p"
}

claw_eval() {
  local js="$1"
  local dest
  dest="$(shell_dest)"
  [ -n "$dest" ] || die "could not find org.gnome.Shell on the session bus"

  gdbus call \
    --session \
    --dest "$dest" \
    --object-path /local/kumo/Claw \
    --method local.kumo.Claw.Eval "$js"
}

apply_opacity() {
  local opacity
  opacity="$(normalize_opacity "${1:-0.82}")"

  claw_eval "
const target = ${opacity};
const targetClass = '${TARGET_WM_CLASS}';
const seen = [];

function text(value) {
  return (value || '').toString().toLowerCase();
}

function isJaxabstractWindow(win) {
  if (targetClass === 'all') return false;
  const title = text(win.get_title && win.get_title());
  const wmClass = text(win.get_wm_class && win.get_wm_class());
  return wmClass !== text(targetClass) && (title.includes('jaxabstract') || wmClass.includes('jaxabstract'));
}

function isTargetWindow(win) {
  const wmClass = text(win.get_wm_class && win.get_wm_class());
  return targetClass === 'all' || wmClass === text(targetClass);
}

for (const actor of global.get_window_actors()) {
  const win = actor.meta_window;
  if (!win) continue;

  const isJax = isJaxabstractWindow(win);
  const isTarget = isTargetWindow(win);
  actor.opacity = isJax ? 255 : (isTarget ? target : 255);

  if (isJax && typeof win.lower === 'function') {
    win.lower();
  }

  seen.push({
    title: win.get_title ? win.get_title() : '',
    wm_class: win.get_wm_class ? win.get_wm_class() : '',
    opacity: actor.opacity,
    jaxabstract: isJax,
    target: isTarget
  });
}

return JSON.stringify(seen);
"
}

restore_opacity() {
  claw_eval "
const seen = [];

for (const actor of global.get_window_actors()) {
  const win = actor.meta_window;
  if (!win) continue;
  actor.opacity = 255;
  seen.push({
    title: win.get_title ? win.get_title() : '',
    wm_class: win.get_wm_class ? win.get_wm_class() : '',
    opacity: actor.opacity
  });
}

return JSON.stringify(seen);
"
}

status() {
  claw_eval "
return JSON.stringify(global.get_window_actors().map(actor => {
  const win = actor.meta_window;
  return {
    title: win && win.get_title ? win.get_title() : '',
    wm_class: win && win.get_wm_class ? win.get_wm_class() : '',
    opacity: actor.opacity
  };
}));
"
}

start_server() {
  ensure_state_dir

  if [ -f "$STATE_DIR/server.pid" ]; then
    local existing
    existing="$(cat "$STATE_DIR/server.pid")"
    if kill -0 "$existing" 2>/dev/null && server_http_ok; then
      return 0
    fi
  fi

  [ -d "$WEB_DIR" ] || die "web directory not found: $WEB_DIR"

  : >"$STATE_DIR/server.log"
  setsid bash -c 'cd "$1" && exec python3 -m http.server "$2" --bind 127.0.0.1' \
    jaxabstract-server "$WEB_DIR" "$PORT" >"$STATE_DIR/server.log" 2>&1 &
  printf '%s\n' "$!" >"$STATE_DIR/server.pid"

  sleep 0.5
  if ! kill -0 "$(cat "$STATE_DIR/server.pid")" 2>/dev/null || ! server_http_ok; then
    rm -f "$STATE_DIR/server.pid"
    sed -n '1,40p' "$STATE_DIR/server.log" >&2
    die "server failed to start on 127.0.0.1:$PORT"
  fi
}

server_http_ok() {
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS -I "$URL" >/dev/null 2>&1
}

server_status() {
  if [ -f "$STATE_DIR/server.pid" ]; then
    local pid
    pid="$(cat "$STATE_DIR/server.pid")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && server_http_ok; then
      echo "RUNNING $pid $URL"
      return 0
    fi
  fi

  echo "STOPPED $URL"
  return 1
}

open_jaxabstract() {
  if command -v flatpak >/dev/null 2>&1 &&
    flatpak list --app --columns=application | grep -qx 'app.zen_browser.zen'; then
    flatpak run app.zen_browser.zen --new-window "$URL" >/dev/null 2>&1 &
    return 0
  fi

  if command -v firefox >/dev/null 2>&1; then
    firefox --new-window "$URL" >/dev/null 2>&1 &
    return 0
  fi

  command -v xdg-open >/dev/null 2>&1 || die "xdg-open is required to open $URL"
  xdg-open "$URL" >/dev/null 2>&1 &
}

lower_jaxabstract_window() {
  claw_eval "
function text(value) {
  return (value || '').toString().toLowerCase();
}

const seen = [];
for (const actor of global.get_window_actors()) {
  const win = actor.meta_window;
  if (!win) continue;

  const title = text(win.get_title && win.get_title());
  const wmClass = text(win.get_wm_class && win.get_wm_class());
  const isJax = title.includes('jaxabstract') || wmClass.includes('zen_browser');

  if (isJax && typeof win.lower === 'function') win.lower();
  seen.push({
    title: win.get_title ? win.get_title() : '',
    wm_class: win.get_wm_class ? win.get_wm_class() : '',
    lowered: isJax
  });
}

return JSON.stringify(seen);
" >/dev/null 2>&1 || true
}

start_terminal() {
  local opacity="${1:-0.72}"
  shift || true

  command -v kitty >/dev/null 2>&1 || die "kitty is required for terminal-native transparency"

  local alpha
  alpha="$(normalize_alpha "$opacity")"

  ensure_state_dir
  start_server
  rm -f "$ACTIVE_FILE" "$OPACITY_FILE"
  open_jaxabstract

  sleep 0.7
  lower_jaxabstract_window

  local command_to_run=("${SHELL:-/usr/bin/bash}" -l)
  if [ "$#" -gt 0 ]; then
    command_to_run=("$@")
  fi

  : >"$TERMINAL_LOG"
  kitty \
    --detach \
    --detached-log "$TERMINAL_LOG" \
    --class jaxabstract-terminal \
    --title "jaxabstract terminal" \
    --override "background_opacity=${alpha}" \
    --override "dynamic_background_opacity=yes" \
    --override "background=#05070d" \
    --override "foreground=#eaf6ff" \
    --override "cursor=#9edbff" \
    --working-directory "$PWD" \
    "${command_to_run[@]}" || {
      sed -n '1,80p' "$TERMINAL_LOG" >&2
      die "kitty failed to launch"
    }

  printf 'RUNNING %s %s\n' "$URL" "kitty opacity=${alpha}"
}

start_background() {
  local opacity="${1:-0.82}"
  local normalized
  normalized="$(normalize_opacity "$opacity")"
  ensure_state_dir
  start_server
  open_jaxabstract
  printf '%s\n' "$normalized" >"$OPACITY_FILE"
  printf '%s\n' "$URL" >"$ACTIVE_FILE"
  policy_install >/dev/null
}

stop_pid_file() {
  local file="$1"
  [ -f "$file" ] || return 0

  local pid
  pid="$(cat "$file")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi

  rm -f "$file"
}

stop_background() {
  rm -f "$ACTIVE_FILE" "$OPACITY_FILE"
  stop_pid_file "$LOOP_PID_FILE"
  rm -f "$STATE_DIR/opacity-loop.log"
  stop_pid_file "$STATE_DIR/watcher.pid"
  rm -f "$STATE_DIR/watcher.log"
  stop_pid_file "$STATE_DIR/server.pid"
  policy_remove >/dev/null
}

run_foreground() {
  local opacity="${1:-0.82}"
  local normalized
  normalized="$(normalize_opacity "$opacity")"
  start_server
  open_jaxabstract
  printf '%s\n' "$normalized" >"$OPACITY_FILE"
  printf '%s\n' "$URL" >"$ACTIVE_FILE"
  policy_install >/dev/null
  trap 'rm -f "$ACTIVE_FILE" "$OPACITY_FILE"; policy_remove >/dev/null || true; stop_pid_file "$STATE_DIR/server.pid"' EXIT INT TERM
  while true; do
    sleep 3600
  done
}

policy_status() {
  ensure_state_dir
  if [ ! -f "$ACTIVE_FILE" ]; then
    restore_opacity >/dev/null
    echo "OK INACTIVE"
    return 0
  fi

  claw_eval "
const policy = globalThis._jaxabstractOpacityPolicy;
if (policy?.installed) {
  return 'OK INSTALLED ' + policy.targetClass + ' ' + policy.opacity;
}
return 'NEEDS_START';
"
}

policy_install() {
  ensure_state_dir
  if [ ! -f "$ACTIVE_FILE" ]; then
    echo "OK INACTIVE"
    return 0
  fi

  local opacity
  opacity="$(cat "$OPACITY_FILE" 2>/dev/null || printf '209')"

  claw_eval "
const target = ${opacity};
const targetClass = '${TARGET_WM_CLASS}';
const JaxGLib = imports.gi.GLib;

function text(value) {
  return (value || '').toString().toLowerCase();
}

function clearPolicy() {
  const old = globalThis._jaxabstractOpacityPolicy;
  if (!old) return;
  for (const [obj, id] of old.signals ?? []) {
    try { obj.disconnect(id); } catch (_) {}
  }
  for (const [obj, id] of old.actors ?? []) {
    try { obj.disconnect(id); } catch (_) {}
  }
  delete globalThis._jaxabstractOpacityPolicy;
}

function applyPolicy() {
  const seen = [];
  for (const actor of global.get_window_actors()) {
    const win = actor.meta_window;
    if (!win) continue;
    const wmClass = text(win.get_wm_class && win.get_wm_class());
    const isTarget = wmClass === text(targetClass);
    actor.opacity = isTarget ? target : 255;
    if (isTarget && !policy.actors.some(([watched]) => watched === actor)) {
      const id = actor.connect('notify::opacity', () => {
        if (actor.opacity !== target) actor.opacity = target;
      });
      policy.actors.push([actor, id]);
    }
    seen.push({
      title: win.get_title ? win.get_title() : '',
      wm_class: win.get_wm_class ? win.get_wm_class() : '',
      opacity: actor.opacity,
      target: isTarget
    });
  }
  return seen;
}

function soon() {
  JaxGLib.timeout_add(JaxGLib.PRIORITY_DEFAULT, 50, () => {
    applyPolicy();
    return JaxGLib.SOURCE_REMOVE;
  });
}

clearPolicy();

const policy = {
  installed: true,
  opacity: target,
  targetClass,
  signals: [],
  actors: []
};

policy.signals.push([global.display, global.display.connect('window-created', soon)]);
policy.signals.push([global.display, global.display.connect('notify::focus-window', soon)]);
globalThis._jaxabstractOpacityPolicy = policy;

const seen = applyPolicy();
return 'OK INSTALLED ' + JSON.stringify(seen);
"
}

policy_remove() {
  claw_eval "
const old = globalThis._jaxabstractOpacityPolicy;
if (old) {
  for (const [obj, id] of old.signals ?? []) {
    try { obj.disconnect(id); } catch (_) {}
  }
  for (const [obj, id] of old.actors ?? []) {
    try { obj.disconnect(id); } catch (_) {}
  }
  delete globalThis._jaxabstractOpacityPolicy;
}
for (const actor of global.get_window_actors()) {
  if (actor.meta_window) actor.opacity = 255;
}
return 'OK REMOVED';
"
}

command="${1:-}"
case "$command" in
  run)
    run_foreground "${2:-0.82}"
    ;;
  start)
    start_background "${2:-0.82}"
    ;;
  terminal)
    opacity="${2:-0.72}"
    if [ "$#" -gt 0 ]; then shift; fi
    if [ "$#" -gt 0 ]; then shift; fi
    start_terminal "$opacity" "$@"
    ;;
  stop)
    stop_background
    ;;
  on)
    apply_opacity "${2:-0.82}"
    ;;
  off)
    restore_opacity
    ;;
  status)
    status
    ;;
  server-status)
    server_status
    ;;
  policy-install)
    policy_install
    ;;
  policy-status)
    policy_status
    ;;
  policy-remove)
    policy_remove
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
