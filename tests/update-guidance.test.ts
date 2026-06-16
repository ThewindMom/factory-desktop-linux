/**
 * Tests for update-guidance module: permission-aware update guidance.
 *
 * Fulfills: VAL-PACKAGE-014
 */

import {
  generateUpdateGuidance,
  formatUpdateGuidance,
} from "../src/update-guidance";
import { ReleaseMode } from "../src/config";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("update-guidance", () => {
  describe("generateUpdateGuidance", () => {
    describe("source-only mode (VAL-PACKAGE-014)", () => {
      test("provides rebuild guidance when update available in source-only mode", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.105.0",
          latestVersion: "0.106.0",
          updateAvailable: true,
          releaseMode: ReleaseMode.Safe,
        });

        expect(result.updateAvailable).toBe(true);
        expect(result.binaryDownloadAvailable).toBe(false);
        expect(result.requiresRebuild).toBe(true);
        expect(result.releasePermissionState).toBe("source-only");
        expect(result.guidance).toContain("rebuild");
        expect(result.guidance).not.toContain("GitHub Releases");
        expect(result.binaryDownloadAvailable).toBe(false);
        expect(result.rebuildSteps!.length).toBeGreaterThan(0);
      });

      test("does not present binary downloads in source-only mode", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.105.0",
          latestVersion: "0.106.0",
          updateAvailable: true,
          releaseMode: ReleaseMode.Safe,
          repoOwner: "test-owner",
          repoName: "test-repo",
        });

        expect(result.binaryDownloadAvailable).toBe(false);
        expect(result.downloadUrl).toBeUndefined();
        expect(result.guidance).not.toContain("GitHub Releases");
      });

      test("reports no update needed when on latest in source-only mode", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.106.0",
          latestVersion: "0.106.0",
          updateAvailable: false,
          releaseMode: ReleaseMode.Safe,
        });

        expect(result.updateAvailable).toBe(false);
        expect(result.requiresRebuild).toBe(false);
        expect(result.guidance).toContain("latest");
      });
    });

    describe("permission-cleared mode", () => {
      test("provides binary download guidance when update available", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.105.0",
          latestVersion: "0.106.0",
          updateAvailable: true,
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
        });

        expect(result.updateAvailable).toBe(true);
        expect(result.binaryDownloadAvailable).toBe(true);
        expect(result.requiresRebuild).toBe(false);
        expect(result.releasePermissionState).toBe("permission-cleared");
        expect(result.downloadUrl).toContain("github.com");
        expect(result.downloadUrl).toContain("0.106.0");
      });

      test("provides in-app updater guidance when safe", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.105.0",
          latestVersion: "0.106.0",
          updateAvailable: true,
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
          updaterRedirectSafe: true,
        });

        expect(result.inAppUpdaterSafe).toBe(true);
        expect(result.guidance).toContain("in-app updater");
      });

      test("reports no update needed when on latest in permission-cleared mode", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.106.0",
          latestVersion: "0.106.0",
          updateAvailable: false,
          releaseMode: ReleaseMode.PermissionCleared,
        });

        expect(result.updateAvailable).toBe(false);
        expect(result.guidance).toContain("latest");
      });
    });

    describe("version drift", () => {
      test("detects and reports version drift", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.105.0",
          latestVersion: "0.106.0",
          updateAvailable: true,
          releaseMode: ReleaseMode.Safe,
        });

        expect(result.versionDrift).toBeDefined();
        expect(result.versionDrift!.detected).toBe(true);
        expect(result.versionDrift!.description).toContain("version drift");
      });

      test("detects droid version drift", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.106.0",
          latestVersion: "0.106.0",
          updateAvailable: false,
          releaseMode: ReleaseMode.Safe,
          droidVersionInfo: {
            currentVersion: "0.105.0",
            latestVersion: "0.106.0",
            drift: true,
          },
        });

        expect(result.versionDrift).toBeDefined();
        expect(result.versionDrift!.detected).toBe(true);
        expect(result.versionDrift!.description).toContain("droid");
      });

      test("no drift when versions match", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.106.0",
          latestVersion: "0.106.0",
          updateAvailable: false,
          releaseMode: ReleaseMode.Safe,
        });

        expect(result.versionDrift!.detected).toBe(false);
      });
    });

    describe("update check failure", () => {
      test("provides manual check guidance when check fails", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.106.0",
          latestVersion: null,
          updateAvailable: false,
          releaseMode: ReleaseMode.Safe,
          checkSucceeded: false,
        });

        expect(result.guidance).toContain("Could not check");
        expect(result.guidance).toContain("factory.ai");
      });

      test("provides manual check guidance when latest is unknown", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.106.0",
          latestVersion: null,
          updateAvailable: false,
          releaseMode: ReleaseMode.Safe,
          checkSucceeded: true,
        });

        expect(result.guidance).toContain("0.106.0");
      });
    });

    describe("distinction between permission states", () => {
      test("source-only mode clearly states no binary downloads", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.105.0",
          latestVersion: "0.106.0",
          updateAvailable: true,
          releaseMode: ReleaseMode.Safe,
        });

        expect(result.guidance).toContain("source-only");
        expect(result.guidance).toContain("rebuild");
        expect(result.binaryDownloadAvailable).toBe(false);
      });

      test("permission-cleared mode provides download URL", () => {
        const result = generateUpdateGuidance({
          currentVersion: "0.105.0",
          latestVersion: "0.106.0",
          updateAvailable: true,
          releaseMode: ReleaseMode.PermissionCleared,
          repoOwner: "test-owner",
          repoName: "test-repo",
        });

        expect(result.binaryDownloadAvailable).toBe(true);
        expect(result.downloadUrl).toBeDefined();
        expect(result.requiresRebuild).toBe(false);
      });
    });
  });

  describe("formatUpdateGuidance", () => {
    test("formats result with all fields", () => {
      const result = generateUpdateGuidance({
        currentVersion: "0.105.0",
        latestVersion: "0.106.0",
        updateAvailable: true,
        releaseMode: ReleaseMode.Safe,
      });

      const formatted = formatUpdateGuidance(result);

      expect(formatted).toContain("Update Guidance");
      expect(formatted).toContain("source-only");
      expect(formatted).toContain("rebuild");
    });
  });
});
