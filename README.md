# Factory Desktop for Linux

> **⚠️ Not an official source.** This repository is a community fork that
> repackages Factory Desktop for Linux. It is **not** the official source of
> Factory Desktop or Droid. The **only official source** is Factory itself —
> download official releases and accounts only from
> [factory.ai](https://factory.ai) and the channels Factory operates. Use this
> port at your own risk.

> **✅ Latest package: [`v1.4.1`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/tag/v1.4.1)**
> (`factory-desktop_1.4.1_amd64.deb` + `Factory-1.4.1.AppImage`), built from the official **Factory Desktop 1.4.1** macOS DMG fetched from Factory's desktop endpoint. The assembled payload was verified locally: `sha256sum -c checksums.txt` passes, `dpkg-deb --info` reports `Version: 1.4.1` / `amd64`, the daemon-transport and system-droid asar patches are present, no droid binary is bundled in `resources/`, and the `factory-desktop://` scheme handler is registered. Installed over 1.3.0, the app registers as `version: 1.4.1` and its daemon answers `factory-daemon ok` on `127.0.0.1:37643` with the matching `droid` CLI 1.4.1. Runs on Linux Mint (x64). Earlier releases (≤ v0.185.0) shipped without the URL-scheme handler and could not complete browser sign-in. Checksums ship with the release.

Factory Desktop running natively on Linux, with `.deb`, `.rpm`, and AppImage
packages built from Factory's official Desktop release.

This community port keeps the familiar Factory interface and adds Linux-native
window controls, updates, and daemon integration. It is unofficial and is not
affiliated with or supported by Factory.

## Download

Current release: [`v1.4.1`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/tag/v1.4.1)

| Package | Download |
|---|---|
| Debian / Ubuntu / Mint (amd64) | [`factory-desktop_1.4.1_amd64.deb`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.4.1/factory-desktop_1.4.1_amd64.deb) |
| Portable AppImage (x86_64) | [`Factory-1.4.1.AppImage`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.4.1/Factory-1.4.1.AppImage) |
| SHA-256 checksums | [`checksums.txt`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.4.1/checksums.txt) |

## What changed in 1.4.1

- **Rebuilt from the official 1.4.1 DMG**
  (`Factory-1.4.1-x64.dmg`), with the Linux packaging patches re-applied to the
  1.4.1 app bundle.
- **Keep the CLI on the same version.** The daemon runs the system `droid` CLI,
  so update it with the desktop:

  ```bash
  droid update --version 1.4.1
  ```

  A desktop that is newer than the CLI is what produced the old
  `400 status code (no body)` / `Unknown model` failures.
- **Daemon port 37643 works.** The package keeps the forced WebSocket transport,
  so `curl -s 127.0.0.1:37643/health` returns `factory-daemon ok` a few seconds
  after launch; earlier builds (0.208.0 and before) could leave that port
  without a live daemon.
- **Verified end to end:** installed over 1.3.0, registered as `version: 1.4.1`,
  `droid doctor` all checks passed, `factory-desktop://` handler registered, no
  droid binary bundled.
- **Factory icon in the panel and tray.** `BrowserWindow` now receives an
  explicit `icon`, so the taskbar/window button shows Factory's logo instead of
  the generic window glyph, and the tray returns the packaged icon on Linux
  instead of the generated monochrome menu-bar glyph.

## Automatic builds

This fork checks Factory's upstream version **daily at 08:00 UTC** and
builds a fresh `.deb` (plus `.AppImage` and SHA-256 checksums) on **every**
run — no manual step needed. When a release for that version already exists,
the new assets replace the old ones in place, so the download is always a
current build.

Automatic update notifications are **off by default**: updates are applied
manually from this repository or from GitHub, so the app no longer raises
"update available" toasts (set `FACTORY_UPDATE_NOTIFICATIONS=1` in the
desktop's environment to turn them back on). Builds are free GitHub Actions runs on this public
repository. You can also trigger a build manually from the **Actions** tab
(*Release → Run workflow*) or with:

```bash
gh workflow run release.yml --ref master
```

## Install

Open the [latest release](https://github.com/seelvupledevelop/factory-desktop-linux/releases/latest)
and download the package for your distribution.

### Ubuntu, Debian, Mint, Pop!_OS, Elementary, Zorin

Download the file ending in `_amd64.deb`, then run:

```bash
sudo apt install ~/Downloads/factory-desktop_*_amd64.deb
```

If your browser saved it somewhere else, replace `~/Downloads/` with that
directory.

### Fedora, RHEL, Rocky, AlmaLinux, openSUSE

Download the file ending in `.x86_64.rpm`, then run:

```bash
sudo dnf install ~/Downloads/factory-desktop-*.x86_64.rpm
```

On openSUSE, use:

```bash
sudo zypper install ~/Downloads/factory-desktop-*.x86_64.rpm
```

### AppImage

Download the `.AppImage`, then run:

```bash
chmod +x ~/Downloads/Factory-*.AppImage
~/Downloads/Factory-*.AppImage
```

The AppImage is portable, but it does not install the native background update
service. Use `.deb` or `.rpm` for the complete experience.

## First Launch

Open **Factory Desktop** from your application menu. You can also launch a
native-package installation from a terminal:

```bash
/opt/Factory/factory-desktop
```

Factory Desktop uses the global `droid` CLI already installed on your computer.
It checks `PATH`, `~/.local/bin/droid`, `/usr/local/bin/droid`, and
`/usr/bin/droid`.

If Droid is missing, Factory Desktop runs Factory's official Linux installer
once. The resulting global CLI is shared by your terminal, Factory Desktop,
Droid Computers, and the background daemon. The Desktop package never contains
its own copy of Droid.

Check the active CLI at any time:

```bash
command -v droid
droid --version
```

## Updating

When an update is available, Factory shows its native orange **Update** button
beside the Back and Forward buttons at the top of the window.

Click **Update** and Factory Desktop will:

1. Download and prepare the latest Linux package.
2. Ask for administrator authorization when installation is ready.
3. Close Factory Desktop.
4. Install the package.
5. Open Factory Desktop again.

You do not need to download another package manually for normal updates.

The global Droid CLI remains separate from Desktop releases. Update it with:

```bash
droid update
```

## How the Droid Daemon Works

Native packages install `factory-droid-daemon.service` as a systemd user
service. Both the service and Factory Desktop use the same global `droid`
executable and the same daemon identity on port `37643`.

Check it with:

```bash
systemctl --user status factory-droid-daemon.service
ps -eo args | grep '[d]roid daemon'
```

Factory first adopts an already healthy global daemon. If Droid was missing,
Desktop installs it globally, restarts the service, and waits for it to become
healthy before considering a direct fallback.

## Reaching Factory from the web app

The web app at [app.factory.ai](https://app.factory.ai) runs no agent locally —
it talks to the Droid daemon on this computer. For the web app to reach this
machine, the daemon must be running and the computer must be registered for
Remote Control. Closing Factory Desktop stops the daemon it started, so for
web-only use start the daemon yourself.

### 1. Register this computer (once)

```bash
droid computer register -y
droid computer list
```

`droid computer list` should show an `active` row ending in `(this machine)`.
Registration survives reboots. Re-run `register -y` after a purge/reinstall, or
when the daemon logs `Remote access requires a registered computer`.

### 2. Start the daemon

Native packages install `factory-droid-daemon.service` as a systemd **user**
service:

```bash
systemctl --user enable --now factory-droid-daemon.service
systemctl --user status factory-droid-daemon.service
```

Or run it in the foreground from a terminal (keep the terminal open):

```bash
droid daemon --host 127.0.0.1 --port 37643 --remote-access
```

`--remote-access` enables Remote Control for the daemon, and the packaged systemd
service passes it. Include it whenever you start the daemon yourself and want
the web app to drive this machine.

Factory Desktop starts or adopts the same daemon on port `37643` when it opens,
so you do not need both. Stop the service before launching a foreground daemon
on that port, and vice versa.

### 3. Verify

```bash
curl -s 127.0.0.1:37643/health   # -> factory-daemon ok
droid doctor
```

Then open <https://app.factory.ai>, select this computer, and start a session.

Notes:

- Keep the daemon running while you use the web app. Without it the computer
  shows as offline and sessions cannot start or resume.
- The daemon binds `127.0.0.1` by default. Do not change `--host` to `0.0.0.0`;
  remote access goes through Factory's relay, not an open local port.
- The desktop app and the web app share the same daemon, so sessions started in
  one appear in the other.

## Troubleshooting

### Factory Desktop does not open

Run it from a terminal to see the startup error:

```bash
/opt/Factory/factory-desktop
```

### The daemon does not start

```bash
command -v droid
droid --version
systemctl --user restart factory-droid-daemon.service
systemctl --user status factory-droid-daemon.service
journalctl --user -u factory-droid-daemon.service -n 100 --no-pager
```

### The Update button does not appear

The button only appears when a newer release is available. Check the update
service and request an immediate check:

```bash
systemctl --user status factory-update-manager.service
factory-update-manager check-now
factory-update-manager status --json
```

### Roll back a bad update

Close Factory Desktop, then run:

```bash
factory-update-manager rollback
```

## Build from Source

Most users should install a package from
[Releases](https://github.com/seelvupledevelop/factory-desktop-linux/releases/latest).
Building locally is intended for contributors and unsupported distributions.

### Prerequisites

- Node.js 18 or newer; Node.js 22 is recommended
- npm
- Rust
- `file`, `sha256sum`, `dpkg-deb` or RPM tools
- `desktop-file-validate`, `xdg-mime`, and `xvfb-run`
- 7-Zip 21 or newer; do not use `p7zip-full` 16.02

Clone and prepare the project:

```bash
git clone https://github.com/seelvupledevelop/factory-desktop-linux.git
cd factory-desktop-linux
npm ci
npm run build
```

Build and install the native package for your distribution:

```bash
make build-app
make package
make install
```

The builder fetches Factory's current official macOS DMG, extracts the Electron
application, applies the Linux compatibility patches, and creates Linux
packages. It never copies the DMG's Droid binary into the Linux application.

### Useful build commands

| Command | Purpose |
|---|---|
| `make build-app` | Fetch the current Factory DMG and assemble the Linux app |
| `make build-app DMG=/path/Factory.dmg` | Build from a specific local DMG |
| `make deb` | Build a Debian package in `dist/` |
| `make rpm` | Build an RPM package in `dist/` |
| `make appimage` | Build an AppImage in `dist/` |
| `make package` | Auto-detect and build the native package format |
| `make install` | Install the newest locally built native package |
| `make run-app` | Run the assembled application |
| `make test` | Run the Rust updater tests |
| `make clean` | Remove generated build artifacts |

Build without the native update manager:

```bash
PACKAGE_WITH_UPDATER=0 make build-app
PACKAGE_WITH_UPDATER=0 make package
make install
```

## Development

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test -- --runInBand

cd updater
cargo fmt --all -- --check
cargo clippy --bin factory-update-manager -- -D warnings
cargo test
```

Linux compatibility changes are applied through the patch registry in
`src/patches/registry.ts`. Package validation rejects any accidental
`resources/bin/droid`, ensuring Desktop always uses the global CLI.

## Release Automation

Every push to `master` that changes the application, packaging, updater, or
release workflow triggers a GitHub Actions build. The daily 08:00 UTC schedule
check also creates a new Linux release automatically whenever Factory Desktop
changes upstream (see [Automatic builds](#automatic-builds)).

Newer automated builds appear in
[Releases](https://github.com/seelvupledevelop/factory-desktop-linux/releases)
as they are produced; they are not hand-verified. The newest
**hand-verified** build is called out at the top of this README.

## Disclaimer

This is an unofficial community project. Factory Desktop and Droid are products
of Factory. Use this port at your own risk and report Linux-port issues in this
repository rather than to Factory support.

## License

MIT
