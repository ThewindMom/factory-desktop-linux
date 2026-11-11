#!/usr/bin/env bash
#
# Uninstall Factory Desktop (unofficial Linux port).
#
#   ./uninstall.sh                Remove the app + system integration,
#                                 KEEP your Factory data (login, sessions,
#                                 settings) — a reinstall picks up where
#                                 you left off.
#   ./uninstall.sh --purge        Remove the app AND all Factory user data
#                                 (~/.factory, ~/.config/Factory, updater
#                                 state) for a truly fresh reinstall.
#   ./uninstall.sh --purge --keep-droid
#                                 Same as --purge but leaves the droid CLI
#                                 installed.
#
# Data removed by --purge:
#   ~/.factory                    CLI + daemon data, sessions, auth
#   ~/.config/Factory             Electron profile (cookies, cache, logs)
#   ~/.cache/factory*             caches
#   ~/.local/state/factory-update-manager   updater state
#   ~/.config/factory-update-manager
#
# The droid CLI lives at ~/.local/bin/droid. --purge removes it unless
# --keep-droid is given.

set -euo pipefail

APP_PACKAGE="factory-desktop"
PURGE=0
KEEP_DROID=0

# Resolve the real user when run under sudo (elevated runs have HOME=/root,
# which would otherwise purge root's home instead of the actual user's).
if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  REAL_USER="$SUDO_USER"
  REAL_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  USER_MACHINE="${SUDO_USER}@.host"
else
  REAL_USER="$(id -un)"
  REAL_HOME="$HOME"
  USER_MACHINE=""
fi

user_ctl() {
  if [ -n "$USER_MACHINE" ]; then
    systemctl --user --machine="$USER_MACHINE" "$@"
  else
    systemctl --user "$@"
  fi
}

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | tail -n +2
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --purge)     PURGE=1 ;;
    --keep-droid) KEEP_DROID=1 ;;
    -h|--help)   usage ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

echo "==> Stopping Factory processes"
pkill -f "/opt/Factory/factory-desktop" 2>/dev/null || true
pkill -f "droid daemon" 2>/dev/null || true
sleep 1

echo "==> Stopping and disabling user services (user: $REAL_USER)"
for unit in factory-droid-daemon.service factory-update-manager.service; do
  user_ctl stop    "$unit" 2>/dev/null || true
  user_ctl disable "$unit" 2>/dev/null || true
done

echo "==> Removing the $APP_PACKAGE package"
if command -v apt-get >/dev/null 2>&1 && dpkg -s "$APP_PACKAGE" >/dev/null 2>&1; then
  sudo apt-get remove -y "$APP_PACKAGE" || sudo dpkg -r "$APP_PACKAGE" || true
elif command -v dnf >/dev/null 2>&1 && rpm -q "$APP_PACKAGE" >/dev/null 2>&1; then
  sudo dnf remove -y "$APP_PACKAGE" || true
elif command -v zypper >/dev/null 2>&1; then
  sudo zypper --non-interactive remove "$APP_PACKAGE" || true
else
  echo "    (package manager for $APP_PACKAGE not found — skipping)"
fi

echo "==> Cleaning user-level integration"
rm -f "$REAL_HOME/.config/systemd/user/factory-droid-daemon.service" \
      "$REAL_HOME/.config/systemd/user/factory-update-manager.service" \
      "$REAL_HOME/.local/share/applications/factory-desktop.desktop"
sed -i '/x-scheme-handler\/factory-desktop/d' "$REAL_HOME/.config/mimeapps.list" 2>/dev/null || true
user_ctl daemon-reload 2>/dev/null || true
update-desktop-database "$REAL_HOME/.local/share/applications" 2>/dev/null || true

if [ "$PURGE" -eq 1 ]; then
  echo "==> Purging all Factory user data ($REAL_HOME)"
  rm -rf "$REAL_HOME/.factory" \
         "$REAL_HOME/.config/Factory" \
         "$REAL_HOME/.cache/factory-desktop" \
         "$REAL_HOME/.cache/factory-update-manager" \
         "$REAL_HOME/.local/state/factory-update-manager" \
         "$REAL_HOME/.config/factory-update-manager"
  if [ "$KEEP_DROID" -eq 1 ]; then
    echo "    Keeping droid CLI as requested ($REAL_HOME/.local/bin/droid)"
  elif [ -e "$REAL_HOME/.local/bin/droid" ]; then
    echo "    Removing droid CLI ($REAL_HOME/.local/bin/droid) — use --keep-droid to keep it"
    rm -f "$REAL_HOME/.local/bin/droid"
  fi
else
  echo "==> Keeping Factory data (login, sessions, settings)."
  echo "    Use --purge to remove it too."
fi

# Leftovers check (package removal normally deletes /opt/Factory)
if [ -d /opt/Factory ]; then
  echo "==> NOTE: /opt/Factory still exists; removing it"
  sudo rm -rf /opt/Factory
fi

echo
echo "Done. Reinstall any time with:"
echo "  apt install ./factory-desktop_<version>_amd64.deb   # keeps data"
echo "  ...then sign in again via the app if you purged."
