/**
 * Tests for updater-redirect module: safe in-app updater redirection
 * for Linux.
 *
 * Fulfills: VAL-PACKAGE-008
 */

import {
  configureUpdaterRedirect,
  validateUpdaterFeedUrl,
  buildGitHubFeedUrl,
  formatUpdaterRedirectResult,
} from "../src/updater-redirect";
import { FACTORY_OFFICIAL_FEED_PATTERNS } from "../src/release-metadata";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("updater-redirect", () => {
  describe("buildGitHubFeedUrl", () => {
    test("builds correct feed URL for latest channel", () => {
      const url = buildGitHubFeedUrl("test-owner", "test-repo");
      expect(url).toBe("https://github.com/test-owner/test-repo/latest-linux.yml");
    });

    test("builds correct feed URL for custom channel", () => {
      const url = buildGitHubFeedUrl("test-owner", "test-repo", "beta");
      expect(url).toBe("https://github.com/test-owner/test-repo/beta-linux.yml");
    });
  });

  describe("validateUpdaterFeedUrl", () => {
    test("accepts this project's GitHub releases feed URL", () => {
      const result = validateUpdaterFeedUrl(
        "https://github.com/test-owner/test-repo/latest-linux.yml",
        "test-owner",
        "test-repo"
      );

      expect(result.valid).toBe(true);
      expect(result.isProjectReleases).toBe(true);
      expect(result.isOfficialFeed).toBe(false);
    });

    test("rejects Factory official update feed URLs", () => {
      const officialUrls = [
        "https://factory.ai/api/update/darwin/0.106.0",
        "https://update.factory.ai/latest-linux.yml",
        "https://github.com/factoryai/desktop/latest-linux.yml",
        "https://github.com/FactoryAI/desktop/latest-linux.yml",
      ];

      for (const url of officialUrls) {
        const result = validateUpdaterFeedUrl(url);
        expect(result.valid).toBe(false);
      }
    });

    test("rejects feed URL pointing to different repository", () => {
      const result = validateUpdaterFeedUrl(
        "https://github.com/other-owner/other-repo/latest-linux.yml",
        "test-owner",
        "test-repo"
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("does not point to the expected repository");
    });

    test("rejects non-HTTPS feed URL", () => {
      const result = validateUpdaterFeedUrl(
        "http://example.com/latest-linux.yml"
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("HTTPS");
    });

    test("accepts localhost for testing", () => {
      const result = validateUpdaterFeedUrl(
        "http://localhost:18080/latest-linux.yml"
      );

      expect(result.valid).toBe(true);
    });

    test("detects Factory official feed patterns", () => {
      for (const pattern of FACTORY_OFFICIAL_FEED_PATTERNS) {
        const result = validateUpdaterFeedUrl(`https://${pattern}/some-path`);
        expect(result.isOfficialFeed).toBe(true);
        expect(result.valid).toBe(false);
      }
    });
  });

  describe("configureUpdaterRedirect", () => {
    test("configures safe redirect with auto-update enabled", () => {
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: true,
      });

      expect(result.feedUrl).toBe("https://github.com/test-owner/test-repo/latest-linux.yml");
      expect(result.feedUrlVerified).toBe(true);
      expect(result.autoUpdateEnabled).toBe(true);
      expect(result.contactsOfficialFeed).toBe(false);
    });

    test("configures redirect with auto-update disabled", () => {
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: false,
      });

      expect(result.autoUpdateEnabled).toBe(false);
    });

    test("configures redirect with custom feed URL", () => {
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: true,
        customFeedUrl: "https://custom.example.com/latest-linux.yml",
      });

      expect(result.feedUrl).toBe("https://custom.example.com/latest-linux.yml");
    });

    test("rejects custom feed URL pointing to Factory official feed", () => {
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: true,
        customFeedUrl: "https://update.factory.ai/latest-linux.yml",
      });

      expect(result.feedUrlVerified).toBe(false);
      expect(result.contactsOfficialFeed).toBe(false); // Not detected from ASAR
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("Factory's official")])
      );
    });

    test("uses correct channel in feed URL", () => {
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: true,
        channel: "beta",
      });

      expect(result.feedUrl).toBe("https://github.com/test-owner/test-repo/beta-linux.yml");
    });

    test("marks safe when feed URL is verified and no ASAR issues", () => {
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: true,
      });

      expect(result.safe).toBe(true);
      expect(result.wouldCrash).toBe(false);
    });

    test("includes findings about update configuration", () => {
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: true,
      });

      expect(result.findings.length).toBeGreaterThan(0);
    });
  });

  describe("formatUpdaterRedirectResult", () => {
    test("formats result correctly", () => {
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: true,
      });

      const formatted = formatUpdaterRedirectResult(result);

      expect(formatted).toContain("Updater Redirect Configuration");
      expect(formatted).toContain("feed URL");
      expect(formatted).toContain("github.com");
    });

    test("auto-update output is not contradictory when disabled with updater code absent", () => {
      // Construct a result where updaterDisabled=true and autoUpdateEnabled
      // should be false despite the user requesting it
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: true,
      });

      // Manually override to simulate the contradictory case
      const contradictoryResult = {
        ...result,
        autoUpdateEnabled: false,  // must be false when updater is disabled
        updaterDisabled: true,
        wouldCrash: false,
      };

      const formatted = formatUpdaterRedirectResult(contradictoryResult);

      // Auto-update line should explain WHY it's disabled, not just say "no"
      expect(formatted).toContain("disabled (no auto-updater code found");
      expect(formatted).toContain("Updater code present: no");
      // Should NOT contain contradictory "enabled: yes" alongside "disabled"
      expect(formatted).not.toMatch(/Auto-update.*enabled.*yes/i);
    });

    test("auto-update output shows crash reason when updater would crash", () => {
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: true,
      });

      const crashResult = {
        ...result,
        autoUpdateEnabled: false,
        wouldCrash: true,
        updaterDisabled: false,
      };

      const formatted = formatUpdaterRedirectResult(crashResult);

      expect(formatted).toContain("disabled (updater code would crash");
    });

    test("auto-update shows enabled when safe and available", () => {
      const result = configureUpdaterRedirect({
        repoOwner: "test-owner",
        repoName: "test-repo",
        enableAutoUpdate: true,
      });

      const formatted = formatUpdaterRedirectResult(result);

      expect(formatted).toContain("Auto-update: enabled");
    });
  });
});
