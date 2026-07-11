# Factory Desktop for Linux

Factory Desktop running natively on Linux, with `.deb`, `.rpm`, and AppImage
packages built from Factory's official Desktop release.

This community port keeps the familiar Factory interface and adds Linux-native
window controls, updates, and daemon integration. It is unofficial and is not
affiliated with or supported by Factory.

## Install

Open the [latest release](https://github.com/ThewindMom/factory-desktop-linux/releases/latest)
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
[Releases](https://github.com/ThewindMom/factory-desktop-linux/releases/latest).
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
git clone https://github.com/ThewindMom/factory-desktop-linux.git
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
release workflow triggers a GitHub Actions build. The workflow publishes `.deb`,
`.rpm`, and AppImage assets to the current Factory Desktop release.

It also checks Factory's upstream version daily and creates a new Linux release
when Factory Desktop changes.

## Disclaimer

This is an unofficial community project. Factory Desktop and Droid are products
of Factory. Use this port at your own risk and report Linux-port issues in this
repository rather than to Factory support.

## License

MIT
