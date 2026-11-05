# Factory Desktop 1.3.0 — unofficial Linux port

Unofficial Linux packaging (`.deb` + AppImage) of **Factory Desktop 1.3.0**, built
from the official macOS DMG fetched from Factory's desktop endpoint. Not
affiliated with or supported by Factory — the only official source is
[factory.ai](https://factory.ai).

## Download

| Package | Link |
|---|---|
| Debian / Ubuntu / Mint (amd64) | [`factory-desktop_1.3.0_amd64.deb`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.3.0/factory-desktop_1.3.0_amd64.deb) |
| Portable AppImage (x86_64) | [`Factory-1.3.0.AppImage`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.3.0/Factory-1.3.0.AppImage) |
| SHA-256 checksums | [`checksums.txt`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.3.0/checksums.txt) |

## Install

### Debian, Ubuntu, Mint, Pop!_OS

```bash
sudo apt install ./factory-desktop_1.3.0_amd64.deb
```

### AppImage

```bash
chmod +x Factory-1.3.0.AppImage
./Factory-1.3.0.AppImage
```

## Verify

```bash
sha256sum -c checksums.txt
```

## What changed in 1.3.0

- **Version bump to Factory Desktop 1.3.0**, rebuilt from the official
  `Factory-1.3.0-x64.dmg` (`https://downloads.factory.ai/factory-desktop/releases/1.3.0/darwin/x64/Factory-1.3.0-x64.dmg`)
  with the Linux packaging patches re-applied to the 1.3.0 bundle.
- **Desktop and CLI on the same version.** The daemon runs the system `droid`
  CLI, so upgrade it alongside the desktop:

  ```bash
  droid update --version 1.3.0
  ```

  Mismatched versions are what produced the old `400 status code (no body)` /
  `Unknown model` failure; with both at 1.3.0 messages send normally.
- **Daemon port 37643 healthy.** The package still forces WebSocket transport,
  and after launch `curl -s 127.0.0.1:37643/health` returns `factory-daemon ok`
  within ~4 s. Earlier builds (0.208.0 and before) could leave that port without
  a live daemon.
- **Registration verified** against this machine's computer id, and
  `droid doctor` reports all checks passed (only unrelated skill-duplication and
  certificate-cache warnings from the local profile).
- **Packaging unchanged:** both asar patches present, no bundled droid binary,
  `factory-desktop://` scheme handler registered, ELF x86-64 `keytar.node`.
- **Factory icon in the panel and tray (revision 2).** `BrowserWindow` now sets
  an explicit `icon`, so the Linux taskbar/window button shows Factory's logo
  rather than the generic window glyph, and the tray returns the packaged icon
  on Linux instead of the generated monochrome menu-bar glyph. Both artifacts
  were rebuilt with these fixes and replace the original 1.3.0 uploads.

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

- `dpkg-deb --info` reports `Version: 1.3.0`, `Architecture: amd64`;
  `sha256sum -c checksums.txt` passes for both artifacts.
- Installed over 1.1.0 with `apt install`, launched, and the startup tracker
  registered `version: 1.3.0` with the daemon ready on `127.0.0.1:37643`
  (`factory-daemon ok`), using `droid` CLI 1.3.0.
- `factory-desktop://` handler registered; old package upgraded cleanly.
- Runs on Linux Mint 22.3 (x64).

## Compatibility

Tested on Linux Mint 22.3 (Ubuntu 24.04 base), x64. Fedora/RHEL packages are
not part of this build; use the AppImage there.
