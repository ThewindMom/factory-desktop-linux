# Factory Desktop 0.187.0 — unofficial Linux port

Unofficial Linux packaging (.deb + AppImage) of **Factory Desktop 0.187.0**, built from the official macOS DMG by the [factory-desktop-linux](https://github.com/seelvupledevelop/factory-desktop-linux) port. Not affiliated with or supported by Factory — the only official source is [factory.ai](https://factory.ai). For upstream feature changes in 0.186.0/0.187.0, see [Factory's official changelog](https://docs.factory.ai/changelog/release-notes).

## Artifacts

| File | Size | SHA-256 |
|---|---|---|
| `factory-desktop_0.187.0_amd64.deb` | 254,814,878 B | `04771cc69deab630e27b38e87776e39b506425bae2bee8ec2c3447e85b0eddd6` |
| `Factory-0.187.0.AppImage` | 254,193,313 B | `9981b0cdc75302587a3ae3186c132225c38eb4eac3a91db3f382b5fd05c40c39` |

Verify: `sha256sum -c checksums-0.187.0.txt`

## Install

```sh
# Debian/Ubuntu/Mint (.deb — installs to /opt/Factory, adds desktop entry and user services)
sudo apt install ./factory-desktop_0.187.0_amd64.deb

# AppImage (portable)
chmod +x Factory-0.187.0.AppImage
./Factory-0.187.0.AppImage
```

## What changed for 0.187.0

- **Fixed browser sign-in deep links (desktop-file registration)** — the .desktop entry shipped by previous packages (including v0.185.0) lacked `MimeType=x-scheme-handler/factory-desktop;` because electron-builder silently drops the `MimeType` key from its `linux.desktop` block. On a cold start (no prior `droid` CLI login), web sign-in ended at Chrome's "No Apps available" dialog and the auth code never reached the app, leaving the daemon in a 401 loop. The scheme is now declared through electron-builder's supported `linux.mimeTypes` option ([`src/packaging.ts`](src/packaging.ts)), and both packages install with the handler registered.
- **Rebuild from the official 0.187.0 DMG** — `Factory-0.187.0-x64.dmg` fetched directly from Factory's desktop endpoint (`app.factory.ai/api/desktop`, S3 `downloads.factory.ai/factory-desktop/releases/0.187.0/darwin/x64/`). Upstream `app.asar` SHA-256: `9df8956c7023fa6dd3df02cffae95fd275a27f7e5f4f2772bce7f89ed0882b0f`.
- **Port source unchanged since v0.185.0** — no commits touch `src/`, `packaging/`, `updater/`, or `packaging/**` between `v0.185.0` and this build (CI-only commits since). All version-agnostic asar patches carried over cleanly: daemon transport (force WebSocket on Linux, adopt the user-owned `factory-droid-daemon.service` on 127.0.0.1:37643), auto-updater guard, window controls, Linux keytar swap, no bundled droid binary.
- **DMG layout auto-detection** (introduced for 0.185.0) still applies: `Factory.app` at the archive root is handled.
- Electron runtime matched to the app (42.3.3); Rust `factory-update-manager` staged into both packages.

## Audit & test evidence

- DMG validation, extraction determinism, and runtime payload validation passed during `build-all` (safe mode; artifacts packaged like CI does).
- Patch markers verified in the built app: `factory-droid-daemon` and port `37643` present in `resources/app.asar`; no `resources/bin/` (never bundles droid); `keytar.node` is the official Linux ELF prebuilt; Rust updater at `.factory-linux/updater/factory-update-manager`.
- `dpkg-deb --info` on the .deb shows `Package: factory-desktop`, `Version: 0.187.0`, `Architecture: amd64`; `sha256sum -c checksums.txt` passes.
- Cold-start verification on Linux Mint 22.3 (no prior droid login): .deb installs and enables both user services; first launch auto-installs droid CLI 0.230.0; after sign-in the daemon health endpoint answers on 127.0.0.1:37643 (`factory-daemon ok`). If your machine predates this fix, register the handler once: `xdg-mime default factory-desktop.desktop x-scheme-handler/factory-desktop`.

## Notes

- Requires the `droid` CLI on PATH (or at `~/.local/bin/droid`); `FACTORY_DROID_PATH` may override it. Desktop runs Factory's official Linux installer once if droid is missing.
- `--remote-access` is included in the shipped unit so remote sessions work; remove it from the unit if you only use local sessions.
