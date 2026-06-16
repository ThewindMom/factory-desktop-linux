/**
 * Update guidance: provides permission-aware update guidance that
 * distinguishes permission-cleared binary releases from source-only
 * rebuild mode.
 *
 * Fulfills: VAL-PACKAGE-014
 *
 * Key behaviors:
 * - In source-only mode, guides users to rebuild from official DMGs
 * - Does not present unavailable binary downloads as installable updates
 * - In permission-cleared mode, provides binary download guidance
 * - Distinguishes update availability from release permission state
 */

import { ReleaseMode, canPublishBinaries } from "./config";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Options for generating update guidance */
export interface UpdateGuidanceOptions {
  /** Current installed/packaged version */
  currentVersion: string;
  /** Latest available version (null if unknown) */
  latestVersion: string | null;
  /** Whether an update is available */
  updateAvailable: boolean;
  /** Current release mode */
  releaseMode: ReleaseMode;
  /** GitHub repository owner (for binary download URLs) */
  repoOwner?: string;
  /** GitHub repository name (for binary download URLs) */
  repoName?: string;
  /** Whether the in-app updater can be safely redirected */
  updaterRedirectSafe?: boolean;
  /** Whether an update check succeeded */
  checkSucceeded?: boolean;
  /** Droid CLI version drift information (optional) */
  droidVersionInfo?: {
    currentVersion: string;
    latestVersion: string | null;
    drift: boolean;
  };
}

/** Update guidance result */
export interface UpdateGuidanceResult {
  /** Whether an update is available */
  updateAvailable: boolean;
  /** Whether the user can install via binary download */
  binaryDownloadAvailable: boolean;
  /** Whether the user needs to rebuild from source */
  requiresRebuild: boolean;
  /** Human-readable guidance message */
  guidance: string;
  /** Step-by-step rebuild instructions (source-only mode) */
  rebuildSteps?: string[];
  /** Binary download URL (permission-cleared mode) */
  downloadUrl?: string;
  /** Version drift information */
  versionDrift?: {
    /** Whether version drift was detected */
    detected: boolean;
    /** Description of the drift */
    description?: string;
  };
  /** The release permission state */
  releasePermissionState: "source-only" | "permission-cleared";
  /** Whether the in-app updater is safe to use */
  inAppUpdaterSafe: boolean;
}

// ─── Guidance Generation ────────────────────────────────────────────────────

/**
 * Generate permission-aware update guidance.
 *
 * VAL-PACKAGE-014: Manual update fallback guidance must distinguish
 * permission-cleared binary releases from source-only rebuild mode.
 * In source-only mode it must guide users to rebuild from official DMGs
 * and must not present unavailable binary downloads as installable updates.
 */
export function generateUpdateGuidance(
  options: UpdateGuidanceOptions
): UpdateGuidanceResult {
  const isPermissionCleared = canPublishBinaries(options.releaseMode);
  const releasePermissionState = isPermissionCleared
    ? "permission-cleared" as const
    : "source-only" as const;

  // Determine version drift
  const versionDrift = detectVersionDrift(options);

  // Determine binary download availability
  const binaryDownloadAvailable = isPermissionCleared &&
    options.updateAvailable &&
    options.latestVersion !== null &&
    !!options.repoOwner &&
    !!options.repoName;

  // Determine if rebuild is required
  const requiresRebuild = !isPermissionCleared && options.updateAvailable;

  // Determine in-app updater safety
  const inAppUpdaterSafe = options.updaterRedirectSafe ?? false;

  // Build guidance message
  let guidance: string;
  let rebuildSteps: string[] | undefined;
  let downloadUrl: string | undefined;

  if (!options.checkSucceeded && options.checkSucceeded !== undefined) {
    // Update check failed
    guidance =
      `Could not check for updates. Current version: ${options.currentVersion}. ` +
      `Visit https://factory.ai to check for updates manually.`;
  } else if (options.updateAvailable && options.latestVersion) {
    if (isPermissionCleared) {
      // Permission-cleared mode: binary download available
      downloadUrl = `https://github.com/${options.repoOwner}/${options.repoName}/releases/tag/v${options.latestVersion}`;

      if (inAppUpdaterSafe) {
        guidance =
          `Factory Desktop ${options.latestVersion} is available (current: ${options.currentVersion}). ` +
          `The in-app updater can automatically download and install this update, ` +
          `or you can download the latest Linux binary release directly.`;
      } else {
        guidance =
          `Factory Desktop ${options.latestVersion} is available (current: ${options.currentVersion}). ` +
          `Download the latest Linux binary release from this project's GitHub Releases page. ` +
          `In-app auto-update is not available for this build.`;
      }
    } else {
      // Source-only mode: NO binary download, must rebuild
      guidance =
        `Factory Desktop ${options.latestVersion} is available (current: ${options.currentVersion}). ` +
        `Binary downloads are not available in source-only mode. ` +
        `To update, you must rebuild from the latest official Factory Desktop DMG ` +
        `using this builder.`;

      rebuildSteps = [
        `1. Download Factory Desktop v${options.latestVersion} x64 DMG from Factory (https://factory.ai)`,
        `2. Run: factory-linux-builder extract --dmg <path-to-dmg>`,
        `3. Run: factory-linux-builder assemble`,
        `4. Run: factory-linux-builder package --targets deb,appimage`,
      ];
    }
  } else if (!options.updateAvailable) {
    guidance = `You are on the latest Factory Desktop version (${options.currentVersion}). No update needed.`;
  } else {
    // Latest version unknown
    guidance =
      `Current version: ${options.currentVersion}. ` +
      `Could not determine if an update is available. ` +
      `Visit https://factory.ai to check for updates manually.`;

    if (!isPermissionCleared) {
      guidance += ` To update, rebuild from the latest official Factory Desktop DMG.`;
    }
  }

  // Append version drift information if detected
  if (versionDrift.detected && versionDrift.description) {
    guidance += ` ${versionDrift.description}`;
  }

  return {
    updateAvailable: options.updateAvailable,
    binaryDownloadAvailable,
    requiresRebuild,
    guidance,
    rebuildSteps,
    downloadUrl,
    versionDrift,
    releasePermissionState,
    inAppUpdaterSafe,
  };
}

/**
 * Detect version drift between current and latest versions.
 *
 * VAL-CROSS-010: When the Factory Desktop latest version or Linux droid
 * latest/matching version differs from the local build inputs, the
 * builder must report the difference and require an explicit policy
 * decision rather than silently combining incompatible components.
 */
function detectVersionDrift(options: UpdateGuidanceOptions): {
  detected: boolean;
  description?: string;
} {
  const drifts: string[] = [];

  // Check Factory Desktop version drift
  if (options.latestVersion && options.currentVersion !== options.latestVersion) {
    drifts.push(
      `Factory Desktop version drift: current=${options.currentVersion}, latest=${options.latestVersion}. ` +
      `An explicit rebuild or update policy decision is required.`
    );
  }

  // Check droid CLI version drift
  if (options.droidVersionInfo?.drift) {
    drifts.push(
      `Factory CLI (droid) version drift: current=${options.droidVersionInfo.currentVersion}` +
      (options.droidVersionInfo.latestVersion
        ? `, latest=${options.droidVersionInfo.latestVersion}`
        : ``) +
      `. Combining incompatible component versions may cause unexpected behavior.`
    );
  }

  if (drifts.length === 0) {
    return { detected: false };
  }

  return {
    detected: true,
    description: drifts.join(" "),
  };
}

/**
 * Format an UpdateGuidanceResult for display.
 */
export function formatUpdateGuidance(result: UpdateGuidanceResult): string {
  const lines: string[] = [];

  lines.push("=== Update Guidance ===");
  lines.push(`Update available: ${result.updateAvailable ? "yes" : "no"}`);
  lines.push(`Release permission: ${result.releasePermissionState}`);
  lines.push(`Binary download: ${result.binaryDownloadAvailable ? "available" : "not available"}`);
  lines.push(`Requires rebuild: ${result.requiresRebuild ? "yes" : "no"}`);
  lines.push(`In-app updater safe: ${result.inAppUpdaterSafe ? "yes" : "no"}`);

  if (result.versionDrift?.detected) {
    lines.push(`Version drift: detected`);
    if (result.versionDrift.description) {
      lines.push(`  ${result.versionDrift.description}`);
    }
  }

  lines.push("");
  lines.push("Guidance:");
  lines.push(`  ${result.guidance}`);

  if (result.rebuildSteps && result.rebuildSteps.length > 0) {
    lines.push("");
    lines.push("Rebuild steps:");
    for (const step of result.rebuildSteps) {
      lines.push(`  ${step}`);
    }
  }

  if (result.downloadUrl) {
    lines.push("");
    lines.push(`Download URL: ${result.downloadUrl}`);
  }

  return lines.join("\n");
}
