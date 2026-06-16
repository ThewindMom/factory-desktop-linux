/**
 * Updater redirect: implements safe in-app updater redirection logic
 * for Linux, ensuring the updater only queries this project's GitHub
 * Releases metadata and never contacts Factory's official macOS/Windows
 * updater feed.
 *
 * Fulfills: VAL-PACKAGE-008
 *
 * Key behaviors:
 * - If the in-app updater is enabled for Linux, it must query this
 *   project's GitHub Releases metadata
 * - The updater must never contact Factory's official macOS/Windows
 *   updater feed for Linux artifacts
 * - Feed URL must be verified and not swappable to upstream
 * - Update errors must not be swallowed without a user-visible
 *   safe fallback
 */

import * as fs from "fs";
import { FACTORY_OFFICIAL_FEED_PATTERNS } from "./release-metadata";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration for the updater redirect */
export interface UpdaterRedirectOptions {
  /** GitHub repository owner for this project's releases */
  repoOwner: string;
  /** GitHub repository name for this project's releases */
  repoName: string;
  /** Release channel (default: "latest") */
  channel?: string;
  /** Whether to use the built-in electron-updater for auto-updates */
  enableAutoUpdate: boolean;
  /** Custom feed URL override (if not using the default GitHub URL) */
  customFeedUrl?: string;
  /** Path to app.asar for static updater analysis */
  asarPath?: string;
}

/** Result of updater redirect configuration */
export interface UpdaterRedirectResult {
  /** Whether the updater redirect is safe and correctly configured */
  safe: boolean;
  /** The feed URL that the Linux updater will use */
  feedUrl: string;
  /** Whether auto-update is enabled for Linux */
  autoUpdateEnabled: boolean;
  /** Whether the feed URL has been verified as safe */
  feedUrlVerified: boolean;
  /** Whether the app would crash due to unsupported updater behavior */
  wouldCrash: boolean;
  /** Whether the updater is disabled on Linux */
  updaterDisabled: boolean;
  /** Whether a safe update-check path is available */
  hasSafeUpdateCheck: boolean;
  /** Whether the app contacts Factory's official updater feed */
  contactsOfficialFeed: boolean;
  /** Detailed findings */
  findings: string[];
  /** Errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/** Result of feed URL validation */
export interface FeedUrlValidationResult {
  /** Whether the feed URL is safe for Linux */
  valid: boolean;
  /** Whether the URL points to this project's releases */
  isProjectReleases: boolean;
  /** Whether the URL points to Factory's official feed */
  isOfficialFeed: boolean;
  /** Reason if invalid */
  reason?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default GitHub base URL */
const GITHUB_BASE = "github.com";

/** Known electron-updater feed URL patterns for GitHub provider */
const GITHUB_FEED_PATTERNS = [
  /github\.com\/[^/]+\/[^/]+\/(latest|update)\/.*\.yml/i,
  /github\.com\/[^/]+\/[^/]+\/releases\/download\/.*\.yml/i,
];

// ─── Updater Redirect ───────────────────────────────────────────────────────

/**
 * Configure the Linux updater to safely redirect to this project's
 * GitHub Releases metadata.
 *
 * VAL-PACKAGE-008: If the in-app updater is enabled for Linux, an
 * IPC-driven update check must show that the Linux app queries this
 * project's GitHub Releases metadata and never contacts or hijacks
 * Factory's official macOS/Windows updater feed.
 *
 * The assertion fails if:
 * - The app checks the upstream desktop updater for Linux artifacts
 * - The feed URL cannot be verified
 * - Update errors are swallowed without a user-visible safe fallback
 */
export function configureUpdaterRedirect(
  options: UpdaterRedirectOptions
): UpdaterRedirectResult {
  const findings: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // Determine the feed URL
  const channel = options.channel || "latest";
  let feedUrl: string;

  if (options.customFeedUrl) {
    feedUrl = options.customFeedUrl;
    findings.push(`Using custom feed URL: ${feedUrl}`);
  } else {
    feedUrl = buildGitHubFeedUrl(options.repoOwner, options.repoName, channel);
    findings.push(`Using generated GitHub feed URL: ${feedUrl}`);
  }

  // Validate the feed URL
  const feedValidation = validateUpdaterFeedUrl(feedUrl, options.repoOwner, options.repoName);
  const feedUrlVerified = feedValidation.valid;

  if (!feedValidation.valid) {
    errors.push(feedValidation.reason || `Feed URL validation failed: ${feedUrl}`);
  }

  if (feedValidation.isOfficialFeed) {
    errors.push(
      `CRITICAL: Feed URL "${feedUrl}" points to Factory's official ` +
      `macOS/Windows updater feed. Linux updater must NEVER hijack the ` +
      `official Factory update channel.`
    );
  }

  // Check ASAR for updater patterns if available
  let wouldCrash = false;
  let updaterDisabled = false;
  let contactsOfficialFeed = false;
  let hasSafeUpdateCheck = false;

  if (options.asarPath && fs.existsSync(options.asarPath)) {
    const asarAnalysis = analyzeAsarForUpdaterPatterns(options.asarPath);
    wouldCrash = asarAnalysis.wouldCrash;
    updaterDisabled = asarAnalysis.updaterDisabled;
    contactsOfficialFeed = asarAnalysis.contactsOfficialFeed;
    hasSafeUpdateCheck = asarAnalysis.hasSafeUpdateCheck;
    findings.push(...asarAnalysis.findings);
  } else {
    // Without ASAR analysis, assume conservative defaults
    findings.push("No ASAR analysis available; assuming updater behavior needs manual verification.");
    hasSafeUpdateCheck = true; // We provide the manual update-check fallback
  }

  // If the updater would crash, disable auto-update and require manual fallback
  if (wouldCrash) {
    warnings.push(
      "The app's updater code may crash on Linux due to unsupported platform assumptions. " +
      "Auto-update is disabled; use the manual update-check fallback instead."
    );
  }

  // If the updater is disabled (no auto-updater code found in app), auto-update
  // cannot actually be enabled regardless of the input flag
  if (options.enableAutoUpdate && updaterDisabled) {
    warnings.push(
      "Auto-update was requested via --enable-auto-update, but no auto-updater code " +
      "was found in the app. Auto-update cannot be enabled; the manual update-check " +
      "fallback will be used instead."
    );
  }

  // If the app contacts the official Factory feed, that's a critical violation
  if (contactsOfficialFeed) {
    errors.push(
      "The app's code contains references to Factory's official updater feed. " +
      "On Linux, this must be redirected to this project's GitHub Releases feed."
    );
  }

  // Evaluate safety
  const safe = !wouldCrash && feedUrlVerified && !contactsOfficialFeed &&
    (updaterDisabled || hasSafeUpdateCheck || options.enableAutoUpdate);

  if (!safe && !hasSafeUpdateCheck) {
    warnings.push(
      "The app may not have a safe update-check path for Linux. " +
      "Consider implementing a manual update-check fallback that reports " +
      "current/latest versions and provides rebuild/download guidance."
    );
  }

  return {
    safe,
    feedUrl,
    autoUpdateEnabled: options.enableAutoUpdate && !wouldCrash && !updaterDisabled,
    feedUrlVerified,
    wouldCrash,
    updaterDisabled,
    hasSafeUpdateCheck,
    contactsOfficialFeed,
    findings,
    errors,
    warnings,
  };
}

/**
 * Build a GitHub Releases feed URL for electron-updater.
 *
 * Format: https://github.com/{owner}/{repo}/latest-linux.yml
 * or for channels: https://github.com/{owner}/{repo}/{channel}-linux.yml
 */
export function buildGitHubFeedUrl(
  owner: string,
  repo: string,
  channel: string = "latest"
): string {
  if (channel === "latest") {
    return `https://${GITHUB_BASE}/${owner}/${repo}/latest-linux.yml`;
  }
  return `https://${GITHUB_BASE}/${owner}/${repo}/${channel}-linux.yml`;
}

/**
 * Validate an updater feed URL to ensure it is safe for Linux.
 *
 * VAL-PACKAGE-008: The Linux updater must never contact or hijack
 * Factory's official macOS/Windows updater feed.
 */
export function validateUpdaterFeedUrl(
  feedUrl: string,
  expectedOwner?: string,
  expectedRepo?: string
): FeedUrlValidationResult {
  // Check if the URL points to Factory's official feed
  for (const pattern of FACTORY_OFFICIAL_FEED_PATTERNS) {
    if (feedUrl.includes(pattern)) {
      return {
        valid: false,
        isProjectReleases: false,
        isOfficialFeed: true,
        reason: `Feed URL "${feedUrl}" points to Factory's official update channel. ` +
          `Linux updater must NEVER use the official Factory macOS/Windows feed.`,
      };
    }
  }

  // Check if the URL looks like a GitHub releases URL
  const isGitHubReleases = feedUrl.includes(GITHUB_BASE) &&
    (feedUrl.includes("latest-linux.yml") ||
     feedUrl.includes("-linux.yml") ||
     GITHUB_FEED_PATTERNS.some((p) => p.test(feedUrl)));

  // If expected owner/repo provided, verify the URL targets them
  if (expectedOwner && expectedRepo && isGitHubReleases) {
    const expectedPattern = `${GITHUB_BASE}/${expectedOwner}/${expectedRepo}`;
    if (!feedUrl.includes(expectedPattern)) {
      return {
        valid: false,
        isProjectReleases: false,
        isOfficialFeed: false,
        reason: `Feed URL "${feedUrl}" does not point to the expected repository ` +
          `${expectedOwner}/${expectedRepo}. The Linux updater must only query this ` +
          `project's GitHub Releases metadata.`,
      };
    }
  }

  // Check for HTTPS
  if (!feedUrl.startsWith("https://") && !feedUrl.startsWith("http://localhost")) {
    return {
      valid: false,
      isProjectReleases: isGitHubReleases,
      isOfficialFeed: false,
      reason: `Feed URL "${feedUrl}" does not use HTTPS. Update feeds must use secure transport.`,
    };
  }

  return {
    valid: true,
    isProjectReleases: isGitHubReleases,
    isOfficialFeed: false,
  };
}

// ─── ASAR Analysis ──────────────────────────────────────────────────────────

/**
 * Analyze the app.asar for updater-related patterns to determine
 * whether the updater behavior is safe for Linux.
 */
function analyzeAsarForUpdaterPatterns(asarPath: string): {
  wouldCrash: boolean;
  updaterDisabled: boolean;
  contactsOfficialFeed: boolean;
  hasSafeUpdateCheck: boolean;
  findings: string[];
} {
  const findings: string[] = [];
  let wouldCrash = false;
  let updaterDisabled = false;
  let contactsOfficialFeed = false;
  let hasSafeUpdateCheck = false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const asar = require("@electron/asar") as typeof import("@electron/asar");
    const fileList = asar.listPackage(asarPath, { isPack: true });

    for (const filePath of fileList) {
      if (!filePath.endsWith(".js")) continue;

      try {
        const content = asar.extractFile(asarPath, filePath).toString("utf-8");

        // Check for auto-updater code
        if (content.includes("autoUpdater") || content.includes("electron-updater") ||
            content.includes("auto-updater")) {
          findings.push(`Auto-updater code found in ${filePath}`);

          // Check for platform-specific handling
          const hasPlatformCheck =
            content.includes("process.platform") ||
            content.includes("process.platform === 'linux'") ||
            content.includes("process.platform == 'linux'");

          const hasLinuxRedirect =
            content.includes("linux") &&
            (content.includes("updateURL") ||
             content.includes("setFeedURL") ||
             content.includes("update-feed") ||
             content.includes("update-check"));

          if (hasPlatformCheck && hasLinuxRedirect) {
            findings.push(`Linux update redirect found in ${filePath}`);
          } else if (hasPlatformCheck && !hasLinuxRedirect) {
            findings.push("Auto-updater with platform checks but no explicit Linux redirect.");
            wouldCrash = true;
          } else {
            findings.push("Auto-updater without platform checks - likely to crash on Linux.");
            wouldCrash = true;
          }
        }

        // Check for Factory official updater feed URLs
        for (const pattern of FACTORY_OFFICIAL_FEED_PATTERNS) {
          if (content.includes(pattern)) {
            contactsOfficialFeed = true;
            findings.push(`Official Factory updater feed URL found in ${filePath}: ${pattern}`);
          }
        }

        // Check for manual update-check path
        if (content.includes("update-check") || content.includes("updateCheck") ||
            content.includes("check-for-update") || content.includes("checkForUpdate")) {
          hasSafeUpdateCheck = true;
          findings.push(`Manual update-check path found in ${filePath}`);
        }
      } catch {
        // Skip files that can't be extracted
      }
    }

    if (!findings.some((f) => f.includes("Auto-updater"))) {
      updaterDisabled = true;
      findings.push("No auto-updater code found in the app.");
    }
  } catch (err) {
    findings.push(`Could not analyze app.asar for updater patterns: ${String(err)}`);
    // Conservative: assume we need manual fallback
    hasSafeUpdateCheck = false;
  }

  return {
    wouldCrash,
    updaterDisabled,
    contactsOfficialFeed,
    hasSafeUpdateCheck,
    findings,
  };
}

/**
 * Format an UpdaterRedirectResult for display.
 */
export function formatUpdaterRedirectResult(result: UpdaterRedirectResult): string {
  const lines: string[] = [];

  lines.push("=== Updater Redirect Configuration ===");
  lines.push(`Safe: ${result.safe ? "yes" : "no"}`);
  lines.push(`Feed URL: ${result.feedUrl}`);
  lines.push(`Feed URL verified: ${result.feedUrlVerified ? "yes" : "no"}`);

  // Show auto-update status with clear explanation of why it may be disabled
  if (result.autoUpdateEnabled) {
    lines.push("Auto-update: enabled");
  } else if (result.updaterDisabled) {
    lines.push("Auto-update: disabled (no auto-updater code found in app)");
  } else if (result.wouldCrash) {
    lines.push("Auto-update: disabled (updater code would crash on Linux)");
  } else {
    lines.push("Auto-update: not requested");
  }

  lines.push(`Updater would crash: ${result.wouldCrash ? "yes" : "no"}`);
  lines.push(`Updater code present: ${result.updaterDisabled ? "no" : "yes"}`);
  lines.push(`Safe update-check path: ${result.hasSafeUpdateCheck ? "yes" : "no"}`);
  lines.push(`Contacts official feed: ${result.contactsOfficialFeed ? "YES - CRITICAL" : "no"}`);

  if (result.findings.length > 0) {
    lines.push("Findings:");
    for (const finding of result.findings) {
      lines.push(`  • ${finding}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ✗ ${error}`);
    }
  }

  return lines.join("\n");
}
