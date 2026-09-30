Unofficial Linux packaging (.deb + AppImage) of **Factory Desktop 0.187.0**, built from the official macOS DMG by the [factory-desktop-linux](https://github.com/seelvupledevelop/factory-desktop-linux) port. Not affiliated with or supported by Factory — official source: [factory.ai](https://factory.ai). For upstream feature changes see [Factory's changelog](https://docs.factory.ai/changelog/release-notes).

## Artifacts (CI-built, run 36774904364)

| File | Size | SHA-256 |
|---|---|---|
| `factory-desktop_0.187.0_amd64.deb` | 258,584,498 B | `477c61da938feaa147509e7ea75b2ae6fa8427f3576db21f8048662afa0879a6` |
| `Factory-0.187.0.AppImage` | 257,969,263 B | `a9a0baca154ba301c44841a4ff58e37e7e7ca1926253fe49fe4ded32cbd51c67` |

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

- **Fixed browser sign-in deep links (scheme-handler registration)** — the .desktop entry shipped by previous packages (including v0.185.0) lacked `MimeType=x-scheme-handler/factory-desktop;` because electron-builder silently drops the `MimeType` key from its `linux.desktop` block. On a cold start (no prior droid CLI login), web sign-in ended at Chrome's "No Apps available" dialog and the auth code never reached the app, leaving the daemon in a 401 loop. The scheme is now declared through electron-builder's supported `linux.mimeTypes` option ([src/packaging.ts](https://github.com/seelvupledevelop/factory-desktop-linux/blob/master/src/packaging.ts)), and both packages install with the handler registered. Fix also proposed upstream in [ThewindMom/factory-desktop-linux#2](https://github.com/ThewindMom/factory-desktop-linux/pull/2).
- **Rebuilt from the official 0.187.0 DMG** — `Factory-0.187.0-x64.dmg` fetched directly from Factory's desktop endpoint (`app.factory.ai/api/desktop`). Upstream `app.asar` SHA-256: `9df8956c7023fa6dd3df02cffae95fd275a27f7e5f4f2772bce7f89ed0882b0f`.
- **Port source otherwise unchanged since v0.185.0** — version-agnostic asar patches carried over: daemon transport (force WebSocket on Linux, user-owned `factory-droid-daemon.service` on 127.0.0.1:37643), auto-updater guard, window controls, Linux keytar swap, no bundled droid binary.
- Electron runtime matched to the app (42.3.3); Rust `factory-update-manager` staged into both packages.

## Audit & test evidence

- `sha256sum -c checksums-0.187.0.txt` passes; `dpkg-deb --info`: `Package: factory-desktop`, `Version: 0.187.0`, `Architecture: amd64`.
- Shipped .desktop verified to contain `MimeType=x-scheme-handler/factory-desktop;` in both artifacts (`dpkg-deb -x` / 7z extraction).
- Patch markers in the built app: `factory-droid-daemon` + port `37643` present in `resources/app.asar`; no `resources/bin/` (never bundles droid); `keytar.node` is the Linux ELF prebuilt; Rust updater staged at `.factory-linux/updater/factory-update-manager`.
- Cold-start verification on Linux Mint 22.3 (no prior droid login): .deb installs and enables both user services; first launch auto-installs droid CLI 0.230.0; after sign-in the daemon health endpoint answers on 127.0.0.1:37643 (`factory-daemon ok`); `droid doctor` reports authenticated; app-daemon WebSocket `ESTAB`; a real `droid exec` session completed end to end.
- If your machine predates this fix, register the handler once: `xdg-mime default factory-desktop.desktop x-scheme-handler/factory-desktop`.

## Notes

- Requires the `droid` CLI on PATH (or at `~/.local/bin/droid`); `FACTORY_DROID_PATH` may override it. Desktop runs Factory's official Linux installer once if droid is missing.
- `--remote-access` is included in the shipped unit so remote sessions work; remove it from the unit if you only use local sessions.

🤖 Generated with Codebuff
