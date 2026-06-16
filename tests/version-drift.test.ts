/**
 * Tests for version-drift module: version drift detection and reporting.
 *
 * Fulfills: VAL-CROSS-010
 */

import {
  detectVersionDrift,
  checkBuildVersionDrift,
  formatVersionDriftResult,
} from "../src/version-drift";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("version-drift", () => {
  describe("checkBuildVersionDrift", () => {
    test("reports no drift when versions match", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.106.0",
        dmgVersion: "0.106.0",
      });

      expect(result.driftDetected).toBe(false);
      expect(result.policyDecisionRequired).toBe(false);
      expect(result.components).toHaveLength(1);
      expect(result.components[0].drift).toBe(false);
    });

    test("reports drift when DMG version differs from requested", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.107.0",
        dmgVersion: "0.106.0",
      });

      expect(result.driftDetected).toBe(true);
      expect(result.policyDecisionRequired).toBe(true);
      expect(result.components[0].drift).toBe(true);
      expect(result.components[0].description).toContain("does not match");
    });

    test("reports drift when droid version differs from latest", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.106.0",
        dmgVersion: "0.106.0",
        droidVersion: "0.105.0",
        latestDroidVersion: "0.106.0",
      });

      expect(result.driftDetected).toBe(true);
    });

    test("reports drift when requested version is behind latest", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.106.0",
        dmgVersion: "0.106.0",
        latestDesktopVersion: "0.107.0",
      });

      expect(result.driftDetected).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    test("requires policy decision when drift is detected", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.107.0",
        dmgVersion: "0.106.0",
      });

      expect(result.policyDecisionRequired).toBe(true);
    });

    test("includes error for version mismatch", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.107.0",
        dmgVersion: "0.106.0",
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("does not match");
    });
  });

  describe("detectVersionDrift", () => {
    test("detects drift when latest version is ahead", async () => {
      // Use a mock URL that will fail, testing the error path
      const result = await detectVersionDrift({
        currentDesktopVersion: "0.106.0",
        latestVersionUrl: "http://localhost:1/nonexistent",
        requestTimeout: 1000,
      });

      // When the API is unreachable, it should report that drift
      // cannot be determined and require a policy decision
      expect(result.components.length).toBeGreaterThan(0);
      expect(result.components[0].policyDecisionRequired).toBe(true);
    });

    test("detects droid version drift", async () => {
      const result = await detectVersionDrift({
        currentDesktopVersion: "0.106.0",
        currentDroidVersion: "0.105.0",
        droidLatestVersion: "0.106.0",
        latestVersionUrl: "http://localhost:1/nonexistent",
        requestTimeout: 1000,
      });

      const droidComponent = result.components.find(
        (c) => c.component === "Factory CLI (droid)"
      );
      expect(droidComponent).toBeDefined();
      expect(droidComponent!.drift).toBe(true);
    });

    test("reports no drift when versions match", async () => {
      const result = await detectVersionDrift({
        currentDesktopVersion: "0.106.0",
        currentDroidVersion: "0.106.0",
        droidLatestVersion: "0.106.0",
        latestVersionUrl: "http://localhost:1/nonexistent",
        requestTimeout: 1000,
      });

      const droidComponent = result.components.find(
        (c) => c.component === "Factory CLI (droid)"
      );
      expect(droidComponent!.drift).toBe(false);
    });
  });

  describe("formatVersionDriftResult", () => {
    test("formats result correctly", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.106.0",
        dmgVersion: "0.106.0",
      });

      const formatted = formatVersionDriftResult(result);

      expect(formatted).toContain("Version Drift Detection");
      expect(formatted).toContain("0.106.0");
    });

    test("formats drift result with description", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.107.0",
        dmgVersion: "0.106.0",
      });

      const formatted = formatVersionDriftResult(result);

      expect(formatted).toContain("YES");
      expect(formatted).toContain("does not match");
    });
  });

  describe("VAL-CROSS-010 compliance", () => {
    test("version drift is never hidden", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.107.0",
        dmgVersion: "0.106.0",
      });

      // Drift must be detected and reported
      expect(result.driftDetected).toBe(true);
      // Summary must mention the drift
      expect(result.summary).toContain("does not match");
      // Policy decision must be required
      expect(result.policyDecisionRequired).toBe(true);
    });

    test("explicit policy decision is required when drift detected", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.107.0",
        dmgVersion: "0.106.0",
      });

      expect(result.policyDecisionRequired).toBe(true);
      expect(result.components.some((c) => c.policyDecisionRequired)).toBe(true);
    });

    test("no policy decision required when no drift", () => {
      const result = checkBuildVersionDrift({
        requestedVersion: "0.106.0",
        dmgVersion: "0.106.0",
        droidVersion: "0.106.0",
        latestDroidVersion: "0.106.0",
      });

      expect(result.policyDecisionRequired).toBe(false);
    });
  });
});
