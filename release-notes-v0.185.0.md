# Factory Desktop 0.185.0 — unofficial Linux port

Unofficial Linux packaging (.deb + AppImage) of **Factory Desktop 0.185.0**, built from the official macOS DMG by the [factory-desktop-linux](https://github.com/ThewindMom/factory-desktop-linux) port.

## Artifacts

| File | Size | SHA-256 |
|---|---|---|
| `factory-desktop_0.185.0_amd64.deb` | 260,973,672 B | `729f6023840e527a56d0c430c12b217e1f7ff11b07efd3160dbccf7c36dbb691` |
| `Factory-0.185.0.AppImage` | 257,723,524 B | `9386e99baf0e1cd4ee99f8eeeda35efed338ef0af213045ef2cd46155d0425f0` |

Verify: `sha256sum -c checksums-0.185.0.txt`

## Install

```sh
# Debian/Ubuntu (.deb — installs to /opt/Factory, adds desktop entry and user services)
sudo apt install ./factory-desktop_0.185.0_amd64.deb

# AppImage (portable)
chmod +x Factory-0.185.0.AppImage
./Factory-0.185.0.AppImage
```

## What changed for 0.185.0

- **DMG layout detection** — 0.185.0 ships `Factory.app` at the archive root (no `Factory/` wrapper); the port auto-detects both layouts.
- **Linux native modules** — macOS `keytar.node` inside `app.asar.unpacked` is swapped for the official hash-pinned Linux prebuilt (keytar 7.9.0, N-API v3).
- **Daemon transport patch rewritten for 0.185.0 asar shapes** — upstream hard-codes IPC transport (`return Zc.Ipc`) and moved the packaged-droid lookup into a destructuring ternary; the patch forces WebSocket on Linux, resolves the **system droid CLI**, and adopts the **user-owned systemd daemon** (`factory-droid-daemon.service`, port 37643).
- **Fix (`o is not iterable`)** — the Linux droid resolver must return the same `{command, prefixArgs, droidPathForSessions}` object the app destructures; a bare string crashed self-spawned daemons.
- **Service unit** — `factory-droid-daemon.service` now runs `droid daemon --remote-access --droid-path "$d" --host 127.0.0.1 --port 37643` (undocumented `--enable-child-ipc` dropped).
- Electron runtime matched to the app (42.3.3); Rust `factory-update-manager` staged into both packages.

## Audit & test evidence

- `tsc --noEmit` clean; `eslint` clean on touched sources.
- Jest: daemon-transport suite **19/19 passed**, including a behavioral test that executes the patched daemon-args builder end to end (WebSocket path, no `--listen ipc`, system droid resolution).
- Package audits: `dpkg-deb`/7z extraction verified ELF updater + Linux keytar + patched asar markers in **both** artifacts; checksums pinned in `checksums-0.185.0.txt`.
- Live verification (Linux Mint 22.3): app connects to the user daemon over WebSocket (`ESTAB factory-desktop ↔ droid on 127.0.0.1:37643`), single daemon instance, `curl /health` → `factory-daemon ok`, **This Computer → Local: green**.

## Notes

- Requires the `droid` CLI on PATH (or at `~/.local/bin/droid`) and `FACTORY_DROID_PATH` may override it.
- `--remote-access` is included in the shipped unit so remote sessions work; remove it from the unit if you only use local sessions.
