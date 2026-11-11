# Factory Desktop 1.1.0 — unofficial Linux port

Unofficial Linux packaging (`.deb` + AppImage) of **Factory Desktop 1.1.0**, built
from the official macOS DMG fetched from Factory's desktop endpoint. Not
affiliated with or supported by Factory — the only official source is
[factory.ai](https://factory.ai).

## Download

| Package | Link |
|---|---|
| Debian / Ubuntu / Mint (amd64) | [`factory-desktop_1.1.0_amd64.deb`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.1.0/factory-desktop_1.1.0_amd64.deb) |
| Portable AppImage (x86_64) | [`Factory-1.1.0.AppImage`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.1.0/Factory-1.1.0.AppImage) |
| SHA-256 checksums | [`checksums.txt`](https://github.com/seelvupledevelop/factory-desktop-linux/releases/download/v1.1.0/checksums.txt) |

## Install

### Debian, Ubuntu, Mint, Pop!_OS

```bash
sudo apt install ./factory-desktop_1.1.0_amd64.deb
```

### AppImage

```bash
chmod +x Factory-1.1.0.AppImage
./Factory-1.1.0.AppImage
```

## Verify

```bash
sha256sum -c checksums.txt
```

## What changed in 1.1.0

- **Daemon port 37643 fixed.** On 0.208.0 and earlier the daemon could fail to
  serve `127.0.0.1:37643`, leaving Factory Desktop and the web app without a
  session backend. The 1.1.0 package forces WebSocket transport and comes up
  healthy: `curl -s 127.0.0.1:37643/health` returns `factory-daemon ok`, and the
  startup tracker reports `outcome: "healthy"` with the daemon ready on port
  37643.
- **HTTP 400 "Unknown model" fixed.** Desktop 1.1.0 and the `droid` CLI 1.1.0
  share the same model catalog, so sending a message no longer fails with
  `400 status code (no body)` / `Unknown model` when the desktop is newer than
  the installed CLI.
- **Rebuilt from the official 1.1.0 DMG** (archive-root `Factory.app` layout)
  with the Linux daemon-transport and system-`droid` adoption patches applied.
  The package bundles no droid binary; it uses the `droid` CLI already installed
  on the machine.
- **Browser sign-in** still completes through the registered
  `factory-desktop://` scheme handler.

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

- `dpkg-deb --info` reports `Version: 1.1.0`, `Architecture: amd64`;
  `sha256sum -c checksums.txt` passes.
- Startup tracker reports `outcome: "healthy"` (~3.5 s), with
  `factory-daemon ok` on `127.0.0.1:37643`.
- Runs on Linux Mint 22.3 (x64).

## Compatibility

Tested on Linux Mint 22.3 (Ubuntu 24.04 base), x64. Fedora/RHEL packages are
not part of this build; use the AppImage there.
