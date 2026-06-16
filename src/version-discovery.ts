/**
 * Version discovery: queries the Factory Desktop latest-version endpoint
 * and validates the response as a semver value.
 *
 * Fulfills: VAL-EXTRACT-002, VAL-EXTRACT-010
 */

import * as https from "https";
import * as http from "http";

/** Factory Desktop latest-version endpoint */
export const LATEST_VERSION_URL =
  "https://api.factory.ai/api/desktop/latest-version";

/** Default timeout for HTTP requests (ms) */
export const DEFAULT_REQUEST_TIMEOUT = 15000;

/** Result of a latest-version discovery attempt */
export interface VersionDiscoveryResult {
  /** Whether discovery succeeded */
  success: boolean;
  /** The resolved semver version (only when success=true) */
  version?: string;
  /** Error description (only when success=false) */
  error?: string;
  /** The raw response body for diagnostics */
  rawResponse?: string;
}

/**
 * Validate that a string is a valid semantic version (major.minor.patch).
 * Does not accept pre-release or build metadata to keep it strict.
 */
export function isValidSemver(version: string): boolean {
  const semverRegex = /^\d+\.\d+\.\d+$/;
  return semverRegex.test(version.trim());
}

/**
 * Fetch a URL with a timeout. Returns the response body as a string.
 * Rejects on timeout, network error, or non-2xx status code.
 */
function fetchUrl(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        res.resume(); // Drain the response to free the connection
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf-8"));
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
 * Parse the latest-version response from the Factory API.
 *
 * Expected response format: { "latestVersion": "X.Y.Z" }
 *
 * Validates that:
 * 1. The response is valid JSON
 * 2. The JSON contains a "latestVersion" field
 * 3. The version is a non-empty string
 * 4. The version matches semver format (X.Y.Z)
 *
 * Returns a VersionDiscoveryResult indicating success or failure.
 */
export function parseLatestVersionResponse(
  responseBody: string
): VersionDiscoveryResult {
  const trimmed = responseBody.trim();

  // Check for empty response
  if (!trimmed) {
    return {
      success: false,
      error: "Empty response from latest-version endpoint.",
      rawResponse: responseBody,
    };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      success: false,
      error: `Malformed JSON response from latest-version endpoint: ${trimmed.substring(0, 200)}`,
      rawResponse: responseBody,
    };
  }

  // Validate response structure
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      success: false,
      error: `Latest-version endpoint returned non-object JSON: ${trimmed.substring(0, 200)}`,
      rawResponse: responseBody,
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Check for latestVersion field
  if (!("latestVersion" in obj)) {
    return {
      success: false,
      error: 'Latest-version response missing "latestVersion" field.',
      rawResponse: responseBody,
    };
  }

  const version = obj.latestVersion;

  // Check version is a string
  if (typeof version !== "string") {
    return {
      success: false,
      error: `Latest-version returned non-string version: ${JSON.stringify(version)}`,
      rawResponse: responseBody,
    };
  }

  // Check version is non-empty
  if (version.trim() === "") {
    return {
      success: false,
      error: "Latest-version returned empty version string.",
      rawResponse: responseBody,
    };
  }

  // Check version is valid semver
  if (!isValidSemver(version)) {
    return {
      success: false,
      error: `Latest-version returned non-semver value: "${version}". Expected format: X.Y.Z`,
      rawResponse: responseBody,
    };
  }

  return {
    success: true,
    version: version.trim(),
  };
}

/**
 * Discover the latest Factory Desktop version from the official endpoint.
 *
 * VAL-EXTRACT-002: Reports the resolved version value, which must be a
 * non-empty semantic version.
 *
 * VAL-EXTRACT-010: If the endpoint times out, returns malformed JSON,
 * returns an empty version, or returns a non-semver value, the builder
 * must fail with a clear diagnostic and must not continue with stale
 * or guessed versions.
 *
 * @param url - Override the default endpoint URL (useful for testing)
 * @param timeoutMs - Request timeout in milliseconds
 */
export async function discoverLatestVersion(
  url: string = LATEST_VERSION_URL,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT
): Promise<VersionDiscoveryResult> {
  let responseBody: string;

  try {
    responseBody = await fetchUrl(url, timeoutMs);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);

    // Classify common failure modes for clear diagnostics
    if (message.includes("timed out")) {
      return {
        success: false,
        error: `Latest-version discovery timed out after ${timeoutMs}ms. ` +
          `Cannot continue without a valid version. ` +
          `Check network connectivity or supply a version explicitly with --version.`,
      };
    }

    if (message.includes("ECONNREFUSED") || message.includes("ENOTFOUND")) {
      return {
        success: false,
        error: `Latest-version endpoint unreachable: ${message}. ` +
          `Cannot continue without a valid version. ` +
          `Check network connectivity or supply a version explicitly with --version.`,
      };
    }

    if (message.startsWith("HTTP ")) {
      return {
        success: false,
        error: `Latest-version endpoint returned an error: ${message}. ` +
          `Cannot continue without a valid version. ` +
          `Supply a version explicitly with --version.`,
      };
    }

    return {
      success: false,
      error: `Latest-version discovery failed: ${message}. ` +
        `Cannot continue without a valid version. ` +
        `Supply a version explicitly with --version.`,
    };
  }

  return addVersionSuggestion(parseLatestVersionResponse(responseBody));
}

/**
 * Add --version fallback suggestion to a failed discovery result.
 */
function addVersionSuggestion(result: VersionDiscoveryResult): VersionDiscoveryResult {
  if (result.success) return result;
  // Only add suggestion if not already present
  if (result.error && !result.error.includes("--version")) {
    return {
      ...result,
      error: result.error +
        " Supply a version explicitly with --version.",
    };
  }
  return result;
}

/**
 * Resolve the Factory Desktop version to use for the build.
 *
 * Priority:
 * 1. Explicit --version flag (user-supplied)
 * 2. Latest-version discovery (when --latest is requested)
 *
 * Returns the resolved version string or an error if version cannot be determined.
 */
export async function resolveVersion(
  options: {
    /** Explicitly requested version */
    version?: string;
    /** Whether to discover the latest version */
    latest?: boolean;
    /** Override URL for testing */
    latestVersionUrl?: string;
    /** Request timeout in ms */
    timeoutMs?: number;
  } = {}
): Promise<VersionDiscoveryResult> {
  // Explicit version takes priority
  if (options.version) {
    const trimmed = options.version.trim();
    if (!isValidSemver(trimmed)) {
      return {
        success: false,
        error: `Requested version "${trimmed}" is not a valid semantic version. Expected format: X.Y.Z`,
      };
    }
    return { success: true, version: trimmed };
  }

  // Latest version discovery
  if (options.latest) {
    return discoverLatestVersion(
      options.latestVersionUrl,
      options.timeoutMs
    );
  }

  return {
    success: false,
    error:
      "No version specified. Use --version <X.Y.Z> or --latest to discover the latest version.",
  };
}
