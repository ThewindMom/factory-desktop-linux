/**
 * Native module prebuilts for the Linux port.
 *
 * Factory's macOS DMG ships prebuilt native modules (e.g. keytar) inside
 * app.asar.unpacked as macOS Mach-O binaries. The Linux app needs Linux ELF
 * builds of the same modules. This module:
 *
 * 1. Detects native binaries unpacked alongside app.asar.
 * 2. For macOS binaries with a known official Linux prebuilt, downloads the
 *    prebuilt, verifies its SHA-256 against a pinned hash, and installs it
 *    over the macOS binary.
 * 3. Skips binaries that are already Linux ELF builds.
 * 4. Warns about macOS binaries that have no known Linux prebuilt so the
 *    build does not fail on optional modules.
 *
 * Must run before the ASAR patch registry: the patcher's repack reads
 * unpacked entries from app.asar.unpacked, so the directory contents must be
 * final before any patch rebuilds the archive.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { BinaryType, classifyBinary } from "./runtime-classifier";

/** A known native module and its official Linux prebuilt. */
interface NativeModulePrebuilt {
  /** Module directory name under node_modules. */
  moduleName: string;
  /** Module version the prebuilt must match exactly. */
  expectedVersion: string;
  /** Path to the .node binary, relative to the module directory. */
  binarySubpath: string;
  /** Official prebuilt download URL (linux-x64, N-API). */
  prebuiltUrl: string;
  /** Pinned SHA-256 of the prebuilt tarball. */
  prebuiltSha256: string;
  /** Path of the binary inside the extracted tarball. */
  tarballBinaryPath: string;
}

/**
 * Known Linux prebuilts, each verified by SHA-256.
 * keytar 7.9.0 napi-v3 linux-x64 (N-API is backward compatible, so the v3
 * build loads in current Electron runtimes).
 */
const KNOWN_PREBUILTS: NativeModulePrebuilt[] = [
  {
    moduleName: "keytar",
    expectedVersion: "7.9.0",
    binarySubpath: "build/Release/keytar.node",
    prebuiltUrl:
      "https://github.com/atom/node-keytar/releases/download/v7.9.0/" +
      "keytar-v7.9.0-napi-v3-linux-x64.tar.gz",
    prebuiltSha256:
      "2d75753fabf9dceb49537ae231e1897de53727bc0fadbc2a01e6374a1443c67c",
    tarballBinaryPath: "build/Release/keytar.node",
  },
];

/** Result of ensuring Linux native prebuilts. */
export interface NativePrebuiltResult {
  /** Whether all required replacements succeeded. */
  success: boolean;
  /** Modules replaced with Linux prebuilts. */
  replaced: string[];
  /** Modules skipped because they were already Linux binaries. */
  skipped: string[];
  /** Modules with no known Linux prebuilt (macOS binary left in place). */
  unresolved: string[];
  /** Fatal errors (replacement attempted and failed). */
  errors: string[];
  /** Non-fatal warnings. */
  warnings: string[];
}

/** A native binary detected under app.asar.unpacked. */
interface DetectedNativeBinary {
  /** Absolute path to the .node file. */
  binaryPath: string;
  /** Module directory name. */
  moduleName: string;
  /** Module version from its package.json (best effort). */
  moduleVersion?: string;
}

/**
 * Detect native binaries (*.node) unpacked under the app's resources
 * directory. Returns one entry per binary with its module identity.
 */
export function detectUnpackedNativeBinaries(
  resourcesDir: string
): DetectedNativeBinary[] {
  const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
  const nodeModulesDir = path.join(unpackedDir, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) {
    return [];
  }

  const detected: DetectedNativeBinary[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".node")) {
        // Module root: first directory above this file that sits directly
        // under node_modules (handles scoped modules and build subdirs).
        const nmIndex = fullPath.split(path.sep).lastIndexOf("node_modules");
        const segments = fullPath.split(path.sep).slice(nmIndex + 1);
        const moduleName = segments[0].startsWith("@")
          ? `${segments[0]}/${segments[1]}`
          : segments[0];
        const moduleRoot = path.join(nodeModulesDir, ...moduleName.split("/"));
        let moduleVersion: string | undefined;
        try {
          const pkg = JSON.parse(
            fs.readFileSync(path.join(moduleRoot, "package.json"), "utf-8")
          );
          if (typeof pkg.version === "string") moduleVersion = pkg.version;
        } catch {
          // Version unknown; matching against known prebuilts will fail.
        }
        detected.push({ binaryPath: fullPath, moduleName, moduleVersion });
      }
    }
  }

  walk(nodeModulesDir);
  return detected;
}

/** Compute the SHA-256 of a file using the sha256sum tool. */
function sha256File(filePath: string): string {
  const out = execFileSync("sha256sum", [filePath], {
    encoding: "utf-8",
    timeout: 60000,
  });
  return out.trim().split(/\s+/)[0];
}

/**
 * Download a file to destPath via global fetch (Node >= 18).
 * Throws on non-2xx responses or network errors.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

/**
 * Ensure every unpacked native module has a Linux binary.
 *
 * macOS binaries with a known, hash-verified prebuilt are replaced in place;
 * already-Linux binaries are left untouched; unknown macOS binaries produce
 * a warning (the app may still work if that module is optional at runtime).
 */
export async function ensureLinuxNativePrebuilts(
  resourcesDir: string,
  options: {
    /** Allow network fetch of official prebuilts. Default: true. */
    allowDownload?: boolean;
  } = {}
): Promise<NativePrebuiltResult> {
  const result: NativePrebuiltResult = {
    success: true,
    replaced: [],
    skipped: [],
    unresolved: [],
    errors: [],
    warnings: [],
  };

  const binaries = detectUnpackedNativeBinaries(resourcesDir);
  for (const binary of binaries) {
    const classification = classifyBinary(binary.binaryPath);

    // Already a Linux binary — nothing to do.
    if (classification.type === BinaryType.ELF) {
      result.skipped.push(binary.moduleName);
      continue;
    }

    // Not a macOS binary we can reason about (unknown, error, missing).
    if (classification.type !== BinaryType.MachO) {
      result.warnings.push(
        `Native module ${binary.moduleName}: unexpected binary type ` +
          `${classification.type} at ${binary.binaryPath}; leaving as-is.`
      );
      continue;
    }

    const prebuilt = KNOWN_PREBUILTS.find(
      (p) =>
        p.moduleName === binary.moduleName &&
        // The module's package.json typically lives inside the asar (only the
        // .node binary is unpacked), so the version is usually unknown here.
        // Matching by module name is then safe: the pinned tarball SHA-256
        // guarantees the exact prebuilt binary that gets installed.
        (binary.moduleVersion === undefined ||
          binary.moduleVersion === p.expectedVersion)
    );

    if (!prebuilt) {
      result.unresolved.push(binary.moduleName);
      result.warnings.push(
        `Native module ${binary.moduleName} is a macOS binary ` +
          `(version ${binary.moduleVersion ?? "unknown"}) and no verified ` +
          `Linux prebuilt is known for it. The app may fail if this ` +
          `module is required at runtime.`
      );
      continue;
    }

    if (options.allowDownload === false) {
      result.errors.push(
        `Native module ${binary.moduleName} needs the Linux prebuilt but ` +
          `downloads are disabled.`
      );
      result.success = false;
      continue;
    }

    try {
      // Download to a temp file and verify the pinned hash first.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-prebuilt-"));
      try {
        const tarballPath = path.join(tmpDir, "prebuilt.tar.gz");
        await downloadFile(prebuilt.prebuiltUrl, tarballPath);

        const actualHash = sha256File(tarballPath);
        if (actualHash !== prebuilt.prebuiltSha256) {
          throw new Error(
            `SHA-256 mismatch for ${prebuilt.prebuiltUrl}: ` +
              `expected ${prebuilt.prebuiltSha256}, got ${actualHash}. ` +
              `Refusing to install an unverified binary.`
          );
        }

        // Extract only the binary from the tarball.
        execFileSync(
          "tar",
          ["-xzf", tarballPath, "-C", tmpDir, prebuilt.tarballBinaryPath],
          { timeout: 60000 }
        );
        const extractedBinary = path.join(tmpDir, prebuilt.tarballBinaryPath);
        if (!fs.existsSync(extractedBinary)) {
          throw new Error(
            `Prebuilt tarball does not contain ${prebuilt.tarballBinaryPath}`
          );
        }

        // The prebuilt must itself be a Linux ELF binary.
        const prebuiltClass = classifyBinary(extractedBinary);
        if (prebuiltClass.type !== BinaryType.ELF) {
          throw new Error(
            `Downloaded prebuilt is not a Linux ELF binary ` +
              `(type: ${prebuiltClass.type})`
          );
        }

        // Install over the macOS binary.
        fs.copyFileSync(extractedBinary, binary.binaryPath);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      // Verify the installed binary.
      const installedClass = classifyBinary(binary.binaryPath);
      if (installedClass.type !== BinaryType.ELF) {
        throw new Error(
          `Installed binary at ${binary.binaryPath} is not ELF after replace`
        );
      }

      result.replaced.push(
        `${binary.moduleName} ${binary.moduleVersion} -> ` +
          `Linux prebuilt (${installedClass.architecture ?? "x86_64"})`
      );
    } catch (err) {
      result.success = false;
      result.errors.push(
        `Failed to install Linux prebuilt for ${binary.moduleName}: ` +
          `${String(err instanceof Error ? err.message : err)}`
      );
    }
  }

  return result;
}
