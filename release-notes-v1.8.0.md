# Factory Desktop 1.8.0 — unofficial Linux port

Unofficial Linux packaging (`.deb` + AppImage) of **Factory Desktop 1.8.0**, built
from the official macOS DMG fetched from Factory's desktop endpoint. Not
affiliated with or supported by Factory — the only official source is
[factory.ai](https://factory.ai).

## Download

| Package | Link |
|---|---|
| Debian / Ubuntu / Mint (amd64) | [`factory-desktop_1.8.0_amd64.deb`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.8.0/factory-desktop_1.8.0_amd64.deb) |
| Portable AppImage (x86_64) | [`Factory-1.8.0.AppImage`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.8.0/Factory-1.8.0.AppImage) |
| SHA-256 checksums | [`checksums.txt`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.8.0/checksums.txt) |

DMG source:
`https://downloads.factory.ai/factory-desktop/releases/1.8.0/darwin/x64/Factory-1.8.0-x64.dmg`

## Install

### Debian, Ubuntu, Mint, Pop!_OS

```bash
sudo apt install ./factory-desktop_1.8.0_amd64.deb
```

### AppImage

```bash
chmod +x Factory-1.8.0.AppImage
./Factory-1.8.0.AppImage
```

## Verify

```bash
sha256sum -c checksums.txt
```

## What changed in 1.8.0

- **Version bump to Factory Desktop 1.8.0**, rebuilt from the official
  `Factory-1.8.0-x64.dmg` with the Linux packaging patches re-applied to the
  1.8.0 app bundle.
- **Desktop and CLI on the same version.** The daemon runs the system `droid`
  CLI, so upgrade it alongside the desktop:

  ```bash
  droid update --version 1.8.0
  ```

  Mismatched versions are what produced the old `400 status code (no body)` /
  `Unknown model` failures.
- **Daemon port 37643 healthy.** The package keeps the forced WebSocket
  transport, so `curl -s 127.0.0.1:37643/health` returns `factory-daemon ok`
  within a few seconds of launch.
- **Packaging unchanged:** both asar patches present, no bundled droid binary,
  `factory-desktop://` scheme handler registered, Rust `factory-update-manager`
  and the `factory-droid-daemon` systemd user unit installed.
- **Factory icon in the panel and tray**, carried over from 1.3.0: `BrowserWindow`
  sets an explicit `icon`, and the tray returns the packaged icon on Linux.
- **No update notifications**, carried over from 1.3.0: Linux updates are manual,
  so the updater's toasts stay off unless `FACTORY_UPDATE_NOTIFICATIONS=1` is set.

## Reaching the web app

The web app at [app.factory.ai](https://app.factory.ai) talks to the daemon on
this computer, so the daemon must be running and the computer registered:

```bash
droid computer register -y          # once
systemctl --user enable --now factory-droid-daemon.service
curl -s 127.0.0.1:37643/health      # -> factory-daemon ok
```

See the repository README for the foreground alternative and troubleshooting.

## Verified

- `dpkg-deb -f` reports `Package: factory-desktop`, `Version: 1.8.0`,
  `Architecture: amd64`; `sha256sum -c checksums.txt` passes for both artifacts,
  locally and on a fresh download from this release.
- Installed over 1.4.1 with `apt install`. `factory-droid-daemon.service` is
  active and the daemon answers `factory-daemon ok` on `127.0.0.1:37643` with
  `droid` CLI 1.8.0; `droid doctor` passed every enabled check (network,
  authentication, credential storage, token refresh, daemon transport).
- `factory-desktop://` handler registered; the launcher appears in the
  **Development** section of the application menu.
- No droid binary bundled in `resources/`; daemon-transport asar markers
  (`factory-droid-daemon`, port 37643) present in the shipped `app.asar`.
- Runs on Linux Mint (x64).

## Compatibility

Tested on Linux Mint (Ubuntu 24.04 base), x64. Fedora/RHEL packages are
not part of this build; use the AppImage there.
