/**
 * Version drift detection: reports version differences between the
 * Factory Desktop latest version, Linux droid CLI latest/matching
 * version, and local build inputs.
 *
 * Fulfills: VAL-CROSS-010
 *
 * Key behaviors:
 * - Detects version drift between Factory Desktop latest and current
 * - Detects version drift between droid CLI latest and current
 * - Reports version differences clearly
 * - Requires an explicit policy decision rather than silently combining
 *   incompatible components
 * - Version drift is never hidden
 */

import * as https from "https";
import * as http from "http";
import { isValidSemver } from "./version-discovery";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Version drift detection options */
export interface VersionDriftOptions {
  /** Current Factory Desktop version (from the build/package) */
  currentDesktopVersion: string;
  /** Current droid CLI version (from the build/package) */
  currentDroidVersion?: string;
  /** Factory Desktop latest-version API URL */
  latestVersionUrl?: string;
  /** Factory CLI version check endpoint or manual version */
  droidLatestVersion?: string;
  /** Request timeout in ms */
  requestTimeout?: number;
}

/** Version drift information for a single component */
export interface ComponentVersionInfo {
  /** Component name */
  component: string;
  /** Current/installed version */
  currentVersion: string;
  /** Latest available version (null if unknown) */
  latestVersion: string | null;
  /** Whether version drift is detected */
  drift: boolean;
  /** Drift direction: "behind" (current < latest), "ahead" (current > latest), or "none" */
  driftDirection: "behind" | "ahead" | "none";
  /** Human-readable drift description */
  description: string;
  /** Whether an explicit policy decision is required */
  policyDecisionRequired: boolean;
}

/** Result of version drift detection */
export interface VersionDriftResult {
  /** Whether drift was detected in any component */
  driftDetected: boolean;
  /** Per-component drift information */
  components: ComponentVersionInfo[];
  /** Overall drift description */
  summary: string;
  /** Whether any policy decision is required */
  policyDecisionRequired: boolean;
  /** Errors encountered during detection */
  errors: string[];
  /** Warnings encountered during detection */
  warnings: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Factory Desktop latest-version endpoint */
const DEFAULT_LATEST_VERSION_URL =
  "https://api.factory.ai/api/desktop/latest-version";

/** Default request timeout (ms) */
const DEFAULT_REQUEST_TIMEOUT = 15000;

// ─── Version Drift Detection ────────────────────────────────────────────────

/**
 * Detect version drift between current build inputs and latest available
 * versions.
 *
 * VAL-CROSS-010: When the Factory Desktop latest version or Linux droid
 * latest/matching version differs from the local build inputs, the builder
 * must report the difference and require an explicit policy decision
 * rather than silently combining incompatible components. The assertion
 * fails if version drift is hidden.
 */
export async function detectVersionDrift(
  options: VersionDriftOptions
): Promise<VersionDriftResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const components: ComponentVersionInfo[] = [];

  // Detect Factory Desktop version drift
  const desktopDrift = await detectDesktopVersionDrift(
    options.currentDesktopVersion,
    options.latestVersionUrl,
    options.requestTimeout
  );
  components.push(desktopDrift);

  if (desktopDrift.drift && desktopDrift.latestVersion === null) {
    errors.push(
      `Could not determine latest Factory Desktop version. ` +
      `Version drift check for desktop component is incomplete.`
    );
  }

  // Detect droid CLI version drift
  if (options.currentDroidVersion) {
    const droidDrift = await detectDroidVersionDrift(
      options.currentDroidVersion,
      options.droidLatestVersion
    );
    components.push(droidDrift);

    if (droidDrift.drift && droidDrift.latestVersion === null) {
      warnings.push(
        `Could not determine latest droid CLI version. ` +
        `Version drift check for droid component is incomplete.`
      );
    }
  }

  // Build summary
  const driftComponents = components.filter((c) => c.drift);
  const driftDetected = driftComponents.length > 0;
  const policyDecisionRequired = components.some((c) => c.policyDecisionRequired);

  let summary: string;
  if (!driftDetected) {
    summary = "No version drift detected. All components are on their latest versions.";
  } else {
    summary = driftComponents.map((c) => c.description).join(" ");
  }

  return {
    driftDetected,
    components,
    summary,
    policyDecisionRequired,
    errors,
    warnings,
  };
}

/**
 * Detect Factory Desktop version drift by querying the latest-version API.
 */
async function detectDesktopVersionDrift(
  currentVersion: string,
  latestVersionUrl?: string,
  requestTimeout?: number
): Promise<ComponentVersionInfo> {
  const url = latestVersionUrl || DEFAULT_LATEST_VERSION_URL;
  const timeout = requestTimeout || DEFAULT_REQUEST_TIMEOUT;

  let latestVersion: string | null = null;

  try {
    latestVersion = await fetchLatestVersion(url, timeout);
  } catch (err) {
    // Could not determine latest version
    return {
      component: "Factory Desktop",
      currentVersion,
      latestVersion: null,
      drift: false, // Cannot determine drift without latest
      driftDirection: "none",
      description:
        `Factory Desktop: current=${currentVersion}, latest=unknown ` +
        `(could not query endpoint). Version drift cannot be determined. ` +
        `An explicit policy decision is required before proceeding.`,
      policyDecisionRequired: true,
    };
  }

  return computeComponentDrift(
    "Factory Desktop",
    currentVersion,
    latestVersion
  );
}

/**
 * Detect droid CLI version drift.
 */
async function detectDroidVersionDrift(
  currentVersion: string,
  providedLatestVersion?: string
): Promise<ComponentVersionInfo> {
  // For droid, we rely on the provided latest version since there's
  // no standard public API for droid CLI latest version
  const latestVersion = providedLatestVersion || null;

  return computeComponentDrift(
    "Factory CLI (droid)",
    currentVersion,
    latestVersion
  );
}

/**
 * Compute drift information for a component.
 */
function computeComponentDrift(
  componentName: string,
  currentVersion: string,
  latestVersion: string | null
): ComponentVersionInfo {
  if (!latestVersion) {
    return {
      component: componentName,
      currentVersion,
      latestVersion: null,
      drift: false,
      driftDirection: "none",
      description:
        `${componentName}: current=${currentVersion}, latest=unknown. ` +
        `Version drift cannot be determined. ` +
        `An explicit policy decision is required.`,
      policyDecisionRequired: true,
    };
  }

  const drift = currentVersion !== latestVersion;
  let driftDirection: "behind" | "ahead" | "none" = "none";

  if (drift) {
    driftDirection = compareVersions(currentVersion, latestVersion);
  }

  let description: string;
  let policyDecisionRequired: boolean;

  if (!drift) {
    description = `${componentName}: current=${currentVersion} (latest). No drift.`;
    policyDecisionRequired = false;
  } else if (driftDirection === "behind") {
    description =
      `${componentName} version drift: current=${currentVersion}, latest=${latestVersion}. ` +
      `The current build is behind the latest available version. ` +
      `An explicit policy decision is required: update to ${latestVersion} or ` +
      `acknowledge the drift before proceeding.`;
    policyDecisionRequired = true;
  } else {
    // ahead or unknown
    description =
      `${componentName} version drift: current=${currentVersion}, latest=${latestVersion}. ` +
      `The current build is ahead of or different from the latest available version. ` +
      `This may indicate a pre-release or custom build. ` +
      `An explicit policy decision is required to proceed with these versions.`;
    policyDecisionRequired = true;
  }

  return {
    component: componentName,
    currentVersion,
    latestVersion,
    drift,
    driftDirection,
    description,
    policyDecisionRequired,
  };
}

/**
 * Compare two semantic versions.
 * Returns "behind" if current < latest, "ahead" if current > latest,
 * or "none" if equal.
 */
function compareVersions(current: string, latest: string): "behind" | "ahead" | "none" {
  const currentParts = current.split(".").map(Number);
  const latestParts = latest.split(".").map(Number);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const c = currentParts[i] || 0;
    const l = latestParts[i] || 0;

    if (c < l) return "behind";
    if (c > l) return "ahead";
  }

  return "none";
}

/**
 * Fetch the latest Factory Desktop version from the API.
 */
async function fetchLatestVersion(
  url: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        res.resume();
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        try {
          const parsed = JSON.parse(body);
          if (parsed.latestVersion && typeof parsed.latestVersion === "string") {
            if (isValidSemver(parsed.latestVersion)) {
              resolve(parsed.latestVersion);
            } else {
              reject(new Error(`Non-semver latest version: ${parsed.latestVersion}`));
            }
          } else {
            reject(new Error("Response missing latestVersion field"));
          }
        } catch {
          reject(new Error(`Malformed JSON response`));
        }
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });
  });
}

/**
 * Format a VersionDriftResult for display.
 */
export function formatVersionDriftResult(result: VersionDriftResult): string {
  const lines: string[] = [];

  lines.push("=== Version Drift Detection ===");
  lines.push(`Drift detected: ${result.driftDetected ? "YES" : "no"}`);
  lines.push(`Policy decision required: ${result.policyDecisionRequired ? "YES" : "no"}`);

  for (const component of result.components) {
    lines.push("");
    lines.push(`Component: ${component.component}`);
    lines.push(`  Current: ${component.currentVersion}`);
    lines.push(`  Latest: ${component.latestVersion || "unknown"}`);
    lines.push(`  Drift: ${component.drift ? "YES" : "no"} (${component.driftDirection})`);
    lines.push(`  Policy decision required: ${component.policyDecisionRequired ? "yes" : "no"}`);

    if (component.drift) {
      lines.push(`  Description: ${component.description}`);
    }
  }

  if (result.summary) {
    lines.push("");
    lines.push(`Summary: ${result.summary}`);
  }

  if (result.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ✗ ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  return lines.join("\n");
}

/**
 * Check version drift for the build command.
 * This is a synchronous check that uses pre-resolved version info.
 *
 * Returns drift information without making network requests.
 * Used during build to enforce version policy.
 */
export function checkBuildVersionDrift(options: {
  /** Requested Factory Desktop version */
  requestedVersion: string;
  /** DMG metadata version */
  dmgVersion: string;
  /** Droid CLI version (if resolved) */
  droidVersion?: string;
  /** Factory Desktop latest version (if known) */
  latestDesktopVersion?: string;
  /** Droid CLI latest version (if known) */
  latestDroidVersion?: string;
}): VersionDriftResult {
  const components: ComponentVersionInfo[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check DMG version matches requested version
  if (options.requestedVersion !== options.dmgVersion) {
    const component = computeComponentDrift(
      "Factory Desktop (DMG vs requested)",
      options.dmgVersion,
      options.requestedVersion
    );
    // Override description for this specific check
    component.description =
      `DMG version (${options.dmgVersion}) does not match requested version ` +
      `(${options.requestedVersion}). An explicit version override or ` +
      `matching DMG is required.`;
    component.policyDecisionRequired = true;
    components.push(component);
    errors.push(component.description);
  } else {
    components.push({
      component: "Factory Desktop (DMG vs requested)",
      currentVersion: options.dmgVersion,
      latestVersion: options.requestedVersion,
      drift: false,
      driftDirection: "none",
      description: `DMG version matches requested version: ${options.dmgVersion}`,
      policyDecisionRequired: false,
    });
  }

  // Check droid version drift if both are provided
  if (options.droidVersion && options.latestDroidVersion) {
    components.push(
      computeComponentDrift(
        "Factory CLI (droid)",
        options.droidVersion,
        options.latestDroidVersion
      )
    );
  }

  // Check against latest Factory Desktop version if known
  if (options.latestDesktopVersion && options.requestedVersion !== options.latestDesktopVersion) {
    const drift = computeComponentDrift(
      "Factory Desktop (vs latest)",
      options.requestedVersion,
      options.latestDesktopVersion
    );
    components.push(drift);
    if (drift.drift) {
      warnings.push(drift.description);
    }
  }

  const driftDetected = components.some((c) => c.drift);
  const policyDecisionRequired = components.some((c) => c.policyDecisionRequired);

  const driftComponents = components.filter((c) => c.drift);
  const summary = driftDetected
    ? driftComponents.map((c) => c.description).join(" ")
    : "No version drift detected. All versions are consistent.";

  return {
    driftDetected,
    components,
    summary,
    policyDecisionRequired,
    errors,
    warnings,
  };
}
