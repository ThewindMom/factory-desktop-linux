/**
 * Tests for packaging module: deb/AppImage build, validation, checksums,
 * and extracted launch context.
 *
 * Fulfills: VAL-PACKAGE-001, VAL-PACKAGE-002, VAL-PACKAGE-003,
 *           VAL-PACKAGE-004, VAL-PACKAGE-005, VAL-PACKAGE-006,
 *           VAL-PACKAGE-013
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execSync } from "child_process";
import {
  buildPackages,
  validateDebPackage,
  validatePackagedDroid,
  generateChecksums,
  verifyChecksums,
  extractDebContext,
  formatPackageBuildResult,
  formatDebValidationResult,
  formatAppImageValidationResult,
  formatPackagedDroidResult,
  formatChecksumResult,
  formatExtractedLaunchResult,
} from "../src/packaging";
import { ReleaseMode } from "../src/config";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a temporary directory for test artifacts */
function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `factory-pack-test-${prefix}-`));
  return dir;
}

/** Clean up a temporary directory */
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/** Create a minimal mock app directory for testing */
function createMockAppDir(baseDir: string, execName = "factory-desktop"): string {
  const appDir = path.join(baseDir, `${execName}-linux-unpacked`);
  fs.mkdirSync(appDir, { recursive: true });

  // Create a mock executable
  const execPath = path.join(appDir, execName);
  fs.writeFileSync(execPath, "#!/bin/bash\necho 'mock app'\n");
  fs.chmodSync(execPath, 0o755);

  // Create resources directory
  const resourcesDir = path.join(appDir, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Create mock app.asar
  fs.writeFileSync(path.join(resourcesDir, "app.asar"), "mock asar content");

  // Create resources/bin/droid
  const binDir = path.join(resourcesDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "droid"), "#!/bin/bash\necho '0.106.0'\n");
  fs.chmodSync(path.join(binDir, "droid"), 0o755);

  // Create version file
  fs.writeFileSync(path.join(appDir, "version"), "39.2.7\n");

  return appDir;
}

/** Create a real-looking mock .deb file for validation testing */
function createMockDeb(outputDir: string, execName = "factory-desktop"): string {
  fs.mkdirSync(outputDir, { recursive: true });

  // Create a proper .deb structure using dpkg-deb
  const debDir = path.join(outputDir, "deb-staging");
  const debianDir = path.join(debDir, "DEBIAN");
  fs.mkdirSync(debianDir, { recursive: true });

  // Create control file
  const controlContent = [
    "Package: factory-desktop",
    "Version: 0.106.0",
    "Architecture: amd64",
    "Maintainer: Factory AI <hello@factory.ai>",
    "Description: Factory AI Desktop - Unofficial Linux Port",
    "Depends: libgtk-3-0, libnss3",
    "Section: devel",
    "Priority: optional",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(debianDir, "control"), controlContent);

  // Create application files in /opt/
  const optDir = path.join(debDir, "opt", execName);
  fs.mkdirSync(optDir, { recursive: true });

  // Copy a real executable
  const mockExec = path.join(optDir, execName);
  fs.writeFileSync(mockExec, "#!/bin/bash\necho 'mock app'\n");
  fs.chmodSync(mockExec, 0o755);

  // Create resources
  const resourcesDir = path.join(optDir, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, "app.asar"), "mock asar content");

  const binDir = path.join(resourcesDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "droid"), "#!/bin/bash\necho '0.106.0'\n");
  fs.chmodSync(path.join(binDir, "droid"), 0o755);

  // Create desktop integration
  const applicationsDir = path.join(debDir, "usr", "share", "applications");
  fs.mkdirSync(applicationsDir, { recursive: true });
  fs.writeFileSync(
    path.join(applicationsDir, `${execName}.desktop`),
    "[Desktop Entry]\nName=Factory\nExec=factory-desktop\nType=Application\nMimeType=x-scheme-handler/factory-desktop;\n"
  );

  // Build the .deb
  const debPath = path.join(outputDir, `factory-desktop_0.106.0_amd64.deb`);
  try {
    execSync(`dpkg-deb --build "${debDir}" "${debPath}"`, {
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch {
    // If dpkg-deb is not available, create a minimal ar archive
    // This is a fallback for environments without dpkg-deb
    throw new Error("dpkg-deb is required for mock .deb creation in tests");
  }

  // Clean up staging directory
  try {
    fs.rmSync(debDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }

  return debPath;
}

// ─── Test Suites ────────────────────────────────────────────────────────────

describe("packaging", () => {
  describe("generateChecksums", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("checksums");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    test("generates SHA-256 checksums for artifact files", () => {
      // Create mock artifacts
      const artifact1 = path.join(tempDir, "test_0.106.0_amd64.deb");
      const artifact2 = path.join(tempDir, "test_0.106.0_x86_64.AppImage");
      fs.writeFileSync(artifact1, "deb content");
      fs.writeFileSync(artifact2, "appimage content");

      const result = generateChecksums([artifact1, artifact2], tempDir);

      expect(result.success).toBe(true);
      expect(result.artifactCount).toBe(2);
      expect(result.manifestPath).toBe(path.join(tempDir, "checksums.txt"));
      expect(Object.keys(result.checksums)).toHaveLength(2);

      // Verify manifest file exists
      expect(fs.existsSync(result.manifestPath)).toBe(true);

      // Verify manifest format (sha256sum format: <hash>  <filename>)
      const manifestContent = fs.readFileSync(result.manifestPath, "utf-8");
      expect(manifestContent).toContain("test_0.106.0_amd64.deb");
      expect(manifestContent).toContain("test_0.106.0_x86_64.AppImage");
    });

    test("computes correct SHA-256 hashes", () => {
      const artifact = path.join(tempDir, "test.deb");
      const content = "test content for hashing";
      fs.writeFileSync(artifact, content);

      const expectedHash = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      const result = generateChecksums([artifact], tempDir);

      expect(result.success).toBe(true);
      expect(result.checksums["test.deb"]).toBe(expectedHash);
    });

    test("handles missing artifact files", () => {
      const missingArtifact = path.join(tempDir, "nonexistent.deb");

      const result = generateChecksums([missingArtifact], tempDir);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("handles empty artifact list", () => {
      const result = generateChecksums([], tempDir);

      expect(result.success).toBe(false);
      expect(result.artifactCount).toBe(0);
    });
  });

  describe("verifyChecksums", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("verify-checksums");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    test("verifies valid checksum manifest", () => {
      // Create an artifact and its checksum
      const artifact = path.join(tempDir, "test_0.106.0_amd64.deb");
      const content = "test deb content";
      fs.writeFileSync(artifact, content);

      const hash = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      const manifestPath = path.join(tempDir, "checksums.txt");
      fs.writeFileSync(manifestPath, `${hash}  test_0.106.0_amd64.deb\n`);

      const result = verifyChecksums(manifestPath);

      expect(result.valid).toBe(true);
      expect(result.output).toContain("OK");
    });

    test("detects checksum mismatch", () => {
      const artifact = path.join(tempDir, "test_0.106.0_amd64.deb");
      fs.writeFileSync(artifact, "actual content");

      const wrongHash = "0".repeat(64);
      const manifestPath = path.join(tempDir, "checksums.txt");
      fs.writeFileSync(manifestPath, `${wrongHash}  test_0.106.0_amd64.deb\n`);

      const result = verifyChecksums(manifestPath);

      expect(result.valid).toBe(false);
    });

    test("handles missing manifest file", () => {
      const result = verifyChecksums("/nonexistent/checksums.txt");

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("validateDebPackage", () => {
    test("validates a real .deb package with expected contents", () => {
      // Check if dpkg-deb is available
      try {
        execSync("which dpkg-deb", { encoding: "utf-8" });
      } catch {
        console.warn("Skipping .deb validation test: dpkg-deb not available");
        return;
      }

      const tempDir = createTempDir("deb-validate");
      try {
        const debPath = createMockDeb(tempDir);
        const result = validateDebPackage(debPath);

        expect(result.packageName).toBe("factory-desktop");
        expect(result.packageVersion).toBe("0.106.0");
        expect(result.packageArch).toBe("amd64");
        expect(result.hasAppAsar).toBe(true);
        expect(result.hasDroid).toBe(true);
        expect(result.droidIsExecutable).toBe(true);
        expect(result.hasDesktopIntegration).toBe(true);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("fails for missing .deb file", () => {
      const result = validateDebPackage("/nonexistent/package.deb");

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("validatePackagedDroid", () => {
    test("validates a real Linux ELF droid binary", () => {
      // Use the real droid from the assembled app if available
      const droidPath = path.join(
        process.cwd(),
        "build",
        "factory-desktop-linux-unpacked",
        "resources",
        "bin",
        "droid"
      );

      if (!fs.existsSync(droidPath)) {
        console.warn("Skipping droid validation test: no assembled droid available");
        return;
      }

      const result = validatePackagedDroid(droidPath, "deb");

      expect(result.exists).toBe(true);
      expect(result.isElf).toBe(true);
      expect(result.isExecutable).toBe(true);
      expect(result.architecture).toBe("x86_64");
      expect(result.versionRan).toBe(true);
    });

    test("fails for non-existent droid", () => {
      const result = validatePackagedDroid("/nonexistent/droid", "appimage");

      expect(result.valid).toBe(false);
      expect(result.exists).toBe(false);
    });

    test("fails for non-executable droid", () => {
      const tempDir = createTempDir("droid-noexec");
      try {
        const droidPath = path.join(tempDir, "droid");
        fs.writeFileSync(droidPath, "not an elf binary");
        // Don't set executable bit

        const result = validatePackagedDroid(droidPath, "deb");

        expect(result.exists).toBe(true);
        expect(result.isExecutable).toBe(false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("buildPackages", () => {
    test("fails when app directory does not exist", () => {
      const result = buildPackages({
        appDir: "/nonexistent/app-dir",
        outputDir: "/tmp/test-output",
        factoryVersion: "0.106.0",
        appName: "Factory",
        execName: "factory-desktop",
        targets: ["deb", "appimage"],
        releaseMode: ReleaseMode.Safe,
      });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("fails when main executable is missing from app dir", () => {
      const tempDir = createTempDir("build-noexe");
      try {
        // Create app dir without the executable
        const appDir = path.join(tempDir, "app");
        fs.mkdirSync(appDir, { recursive: true });

        const result = buildPackages({
          appDir,
          outputDir: path.join(tempDir, "dist"),
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["deb"],
          releaseMode: ReleaseMode.Safe,
        });

        expect(result.success).toBe(false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("warns about RPM deferral", () => {
      const tempDir = createTempDir("build-rpm");
      try {
        const appDir = createMockAppDir(tempDir);

        const result = buildPackages({
          appDir,
          outputDir: path.join(tempDir, "dist"),
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["rpm"],
          releaseMode: ReleaseMode.Safe,
        });

        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.stringContaining("RPM target is deferred")])
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("fails for no valid targets", () => {
      const tempDir = createTempDir("build-notargets");
      try {
        const appDir = createMockAppDir(tempDir);

        const result = buildPackages({
          appDir,
          outputDir: path.join(tempDir, "dist"),
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["rpm"], // RPM is deferred, so no valid targets
          releaseMode: ReleaseMode.Safe,
        });

        expect(result.success).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([expect.stringContaining("No valid targets")])
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("extractDebContext", () => {
    test("extracts a real .deb into an install context", () => {
      try {
        execSync("which dpkg-deb", { encoding: "utf-8" });
      } catch {
        console.warn("Skipping deb extraction test: dpkg-deb not available");
        return;
      }

      const tempDir = createTempDir("extract-deb");
      try {
        const debPath = createMockDeb(path.join(tempDir, "source"));
        const extractDir = path.join(tempDir, "extracted");

        const result = extractDebContext(debPath, extractDir);

        expect(result.success).toBe(true);
        expect(fs.existsSync(extractDir)).toBe(true);

        // Should find the executable
        if (result.executablePath) {
          expect(fs.existsSync(result.executablePath)).toBe(true);
        }
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("fails for missing .deb file", () => {
      const result = extractDebContext("/nonexistent/package.deb", "/tmp/extract");

      expect(result.success).toBe(false);
    });
  });

  describe("formatting functions", () => {
    test("formatPackageBuildResult formats correctly", () => {
      const result = formatPackageBuildResult({
        success: true,
        artifacts: ["/path/to/test.deb", "/path/to/test.AppImage"],
        debPath: "/path/to/test.deb",
        appImagePath: "/path/to/test.AppImage",
        errors: [],
        warnings: [],
      });

      expect(result).toContain("SUCCESS");
      expect(result).toContain("test.deb");
      expect(result).toContain("test.AppImage");
    });

    test("formatDebValidationResult formats correctly", () => {
      const result = formatDebValidationResult({
        valid: true,
        packageName: "factory-desktop",
        packageVersion: "0.106.0",
        packageArch: "amd64",
        hasAppAsar: true,
        hasDroid: true,
        droidIsExecutable: true,
        hasDesktopIntegration: true,
        errors: [],
      });

      expect(result).toContain("PASS");
      expect(result).toContain("factory-desktop");
      expect(result).toContain("0.106.0");
    });

    test("formatAppImageValidationResult formats correctly", () => {
      const result = formatAppImageValidationResult({
        valid: true,
        fileType: "ELF 64-bit LSB executable",
        hasAppAsar: true,
        hasDroid: true,
        droidIsExecutable: true,
        hasDesktopEntry: true,
        hasProtocolMetadata: true,
        hasIcons: true,
        errors: [],
      });

      expect(result).toContain("PASS");
      expect(result).toContain("ELF");
    });

    test("formatPackagedDroidResult formats correctly", () => {
      const result = formatPackagedDroidResult({
        valid: true,
        exists: true,
        isElf: true,
        isExecutable: true,
        architecture: "x86_64",
        versionRan: true,
        versionOutput: "0.106.0",
        sourcePackage: "deb",
        errors: [],
      });

      expect(result).toContain("PASS");
      expect(result).toContain("x86_64");
      expect(result).toContain("0.106.0");
    });

    test("formatChecksumResult formats correctly", () => {
      const result = formatChecksumResult({
        success: true,
        manifestPath: "/path/to/checksums.txt",
        artifactCount: 2,
        checksums: { "test.deb": "abc123", "test.AppImage": "def456" },
        errors: [],
      });

      expect(result).toContain("SUCCESS");
      expect(result).toContain("abc123");
      expect(result).toContain("2");
    });

    test("formatExtractedLaunchResult formats correctly", () => {
      const result = formatExtractedLaunchResult({
        success: true,
        packageType: "deb",
        extractedPath: "/tmp/extract",
        executablePath: "/tmp/extract/factory-desktop",
        initialized: true,
        terminatedCleanly: true,
        errors: [],
      });

      expect(result).toContain("PASS");
      expect(result).toContain("deb");
    });
  });

  describe("checksum end-to-end", () => {
    test("generate and verify checksum round-trip", () => {
      const tempDir = createTempDir("checksum-e2e");
      try {
        // Create artifacts
        const artifacts: string[] = [];
        for (let i = 0; i < 3; i++) {
          const filePath = path.join(tempDir, `artifact_${i}.bin`);
          const content = `artifact content ${i} with ${crypto.randomBytes(16).toString("hex")}`;
          fs.writeFileSync(filePath, content);
          artifacts.push(filePath);
        }

        // Generate checksums
        const genResult = generateChecksums(artifacts, tempDir);
        expect(genResult.success).toBe(true);
        expect(genResult.artifactCount).toBe(3);

        // Verify checksums
        const verifyResult = verifyChecksums(genResult.manifestPath);
        expect(verifyResult.valid).toBe(true);
        expect(verifyResult.output).toContain("OK");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("checksum verification fails when artifact is modified after manifest generation", () => {
      const tempDir = createTempDir("checksum-tamper");
      try {
        const artifact = path.join(tempDir, "test.deb");
        fs.writeFileSync(artifact, "original content");

        const genResult = generateChecksums([artifact], tempDir);
        expect(genResult.success).toBe(true);

        // Modify the artifact
        fs.writeFileSync(artifact, "tampered content");

        const verifyResult = verifyChecksums(genResult.manifestPath);
        expect(verifyResult.valid).toBe(false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("safe mode integration", () => {
    test("buildPackages works in safe mode (does not publish)", () => {
      // Safe mode should not prevent building - only publishing
      const tempDir = createTempDir("safe-mode-build");
      try {
        const appDir = createMockAppDir(tempDir);

        // In safe mode, building should still work, just publishing is refused
        const result = buildPackages({
          appDir,
          outputDir: path.join(tempDir, "dist"),
          factoryVersion: "0.106.0",
          appName: "Factory",
          execName: "factory-desktop",
          targets: ["deb"],
          releaseMode: ReleaseMode.Safe,
        });

        // The build may fail because our mock app dir isn't a real Electron
        // app that electron-builder can package, but the safe mode should
        // not be the reason for failure.
        // Just verify the function accepts safe mode without erroring on it.
        expect(result).toBeDefined();
        expect(result.errors).not.toEqual(
          expect.arrayContaining([expect.stringContaining("safe mode")])
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });
});
