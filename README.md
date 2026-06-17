# Factory Droid Desktop Linux Port Builder

Unofficial Linux port builder for Factory Droid Desktop. This project is not affiliated with, endorsed by, or supported by Factory.

The repository is a source-only builder. Users supply an official Factory Desktop macOS DMG, and the tool extracts only the local inputs needed to assemble Linux packages. Built `.deb`, AppImage, update metadata, extracted payloads, `app.asar`, DMG contents, and downloaded `droid` binaries are proprietary-derived/generated artifacts and must not be committed. Publishing binary artifacts is permission-gated and refused by default.

## Prerequisites

- Node.js `>=18` (validated with Node `20.17.0`)
- npm
- `7z`
- `file`
- `sha256sum`
- `dpkg-deb`
- `desktop-file-validate`
- `xdg-mime`
- `xvfb-run`

Project dependencies pin `electron@39.2.7`, `electron-builder@25.1.8`, and `electron-updater@6.6.2`.

## Quick Start

```bash
npm install --no-audit --no-fund
npm run build
node dist/cli.js check-tools
```

Build from a user-supplied official Factory Desktop DMG:

```bash
node dist/cli.js build-all \
  --dmg /path/to/Factory-x64.dmg \
  --targets deb,appimage \
  --validate
```

Optionally verify x64/arm64 payload parity:

```bash
node dist/cli.js build-all \
  --dmg /path/to/Factory-x64.dmg \
  --arm64-dmg /path/to/Factory-arm64.dmg \
  --targets deb,appimage \
  --validate
```

Package an already assembled app:

```bash
npm run package -- --targets deb,appimage --validate
```

Run project validators:

```bash
npm run validate
```

## Release Metadata And Update Modes

Safe/source-only mode is the default. It refuses to publish binary artifacts or generate update metadata that implies proprietary binary availability:

```bash
node dist/cli.js release-metadata \
  --release-mode safe \
  --release-version 0.106.0 \
  --validate
```

Permission-cleared mode may generate GitHub Releases metadata for `.deb` and AppImage artifacts when redistribution approval exists:

```bash
node dist/cli.js release-metadata \
  --release-mode permission-cleared \
  --release-version 0.106.0 \
  --repo-owner <owner> \
  --repo-name <repo> \
  --validate

node dist/cli.js validate-updater --metadata-path dist/latest-linux.yml
```

The builder can discover the latest Factory Desktop version from Factory's public endpoint and compare it to local build inputs. If safe in-app update redirection is unavailable, use the manual update-check fallback:

```bash
node dist/cli.js discover-version --latest
node dist/cli.js update-check --current-version 0.106.0
node dist/cli.js update-guidance --current-version 0.106.0
```

In source-only mode, update guidance points users to rebuild from official DMGs. In permission-cleared mode, GitHub Releases metadata can be used for Linux artifacts without hijacking Factory's official macOS/Windows update channel.

## Generated Files And Artifact Hygiene

Generated directories are ignored by git:

- `work/` extraction workspace and downloaded Linux `droid`
- `build/` assembled Linux Electron app
- `dist/` TypeScript output and release metadata/checksums
- `out/` package output
- `.cache/` local cache

Do not commit proprietary payloads or generated binaries, including `.dmg`, `.deb`, `.rpm`, `.AppImage`, `.asar`, extracted `Factory.app` contents, downloaded `droid` binaries, tokens, credentials, or session data.

## Packaging Targets

Supported first-class targets:

- Debian package (`.deb`)
- AppImage

RPM is explicitly deferred unless `rpmbuild` is available or an approved and verified Docker RPM strategy is configured. Until then, RPM requests fail fast and must not leave partial `.rpm` artifacts or appear in release metadata.
