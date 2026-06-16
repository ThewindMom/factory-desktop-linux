/**
 * Updater schema validation: validates generated Linux update metadata
 * against the electron-updater UpdateInfo schema.
 *
 * Fulfills: VAL-PACKAGE-012
 *
 * Key behaviors:
 * - Validates that metadata satisfies the chosen updater schema
 * - Checks required version, path/URL, release date, size, and
 *   SHA-512 hash fields
 * - Validates both the deprecated top-level path/sha512 and the
 *   files array format required by electron-updater
 * - Rejects metadata that validates only as generic YAML but not
 *   as updater-compatible metadata
 */

import * as fs from "fs";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Schema validation severity */
export type ValidationSeverity = "error" | "warning";

/** A single schema validation finding */
export interface SchemaValidationFinding {
  /** Severity of the finding */
  severity: ValidationSeverity;
  /** Field or section that the finding relates to */
  field: string;
  /** Description of the issue */
  message: string;
}

/** Result of schema validation */
export interface SchemaValidationResult {
  /** Whether the metadata is valid against the updater schema */
  valid: boolean;
  /** Total number of errors */
  errorCount: number;
  /** Total number of warnings */
  warningCount: number;
  /** All findings */
  findings: SchemaValidationFinding[];
  /** The parsed metadata object (if parsing succeeded) */
  parsed?: ParsedUpdateMetadata;
}

/** Parsed update metadata from latest-linux.yml */
export interface ParsedUpdateMetadata {
  /** Version string */
  version: string;
  /** Files array */
  files: ParsedUpdateFile[];
  /** Primary artifact path (deprecated but required) */
  path: string;
  /** Primary artifact SHA-512 (deprecated but required, base64) */
  sha512: string;
  /** Release date */
  releaseDate: string;
  /** Release name (optional) */
  releaseName?: string;
  /** Release notes (optional) */
  releaseNotes?: string;
  /** Channel (optional) */
  channel?: string;
}

/** Parsed file entry from update metadata */
export interface ParsedUpdateFile {
  /** URL or filename of the artifact */
  url: string;
  /** SHA-512 hash (base64-encoded) */
  sha512: string;
  /** File size in bytes */
  size: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a latest-linux.yml file against the electron-updater schema.
 *
 * VAL-PACKAGE-012: Generated Linux update metadata must satisfy the
 * chosen updater schema, including required version, path or URL,
 * release date, size, and updater hash fields such as SHA-512 when
 * required. The assertion fails if metadata validates only as generic
 * YAML but not as updater-compatible metadata.
 *
 * @param metadataPath - Path to the latest-linux.yml file, or
 * @param metadataContent - Raw YAML content string
 */
export function validateUpdaterSchema(options: {
  metadataPath?: string;
  metadataContent?: string;
}): SchemaValidationResult {
  const findings: SchemaValidationFinding[] = [];

  // Step 1: Read or use provided content
  let content: string;
  if (options.metadataContent) {
    content = options.metadataContent;
  } else if (options.metadataPath) {
    if (!fs.existsSync(options.metadataPath)) {
      return {
        valid: false,
        errorCount: 1,
        warningCount: 0,
        findings: [{
          severity: "error",
          field: "file",
          message: `Metadata file not found: ${options.metadataPath}`,
        }],
      };
    }
    content = fs.readFileSync(options.metadataPath, "utf-8");
  } else {
    return {
      valid: false,
      errorCount: 1,
      warningCount: 0,
      findings: [{
        severity: "error",
        field: "input",
        message: "Either metadataPath or metadataContent must be provided.",
      }],
    };
  }

  // Step 2: Parse as YAML (simple parser for the known schema)
  let parsed: ParsedUpdateMetadata;
  try {
    parsed = parseUpdateYaml(content);
  } catch (err) {
    return {
      valid: false,
      errorCount: 1,
      warningCount: 0,
      findings: [{
        severity: "error",
        field: "yaml",
        message: `Failed to parse YAML: ${String(err)}`,
      }],
    };
  }

  // Step 3: Validate against electron-updater UpdateInfo schema
  validateVersion(parsed, findings);
  validateFiles(parsed, findings);
  validatePath(parsed, findings);
  validateSha512(parsed, findings);
  validateReleaseDate(parsed, findings);

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;

  return {
    valid: errorCount === 0,
    errorCount,
    warningCount,
    findings,
    parsed,
  };
}

/**
 * Validate the version field.
 */
function validateVersion(parsed: ParsedUpdateMetadata, findings: SchemaValidationFinding[]): void {
  if (!parsed.version) {
    findings.push({
      severity: "error",
      field: "version",
      message: "Required field 'version' is missing.",
    });
    return;
  }

  if (!/^\d+\.\d+\.\d+/.test(parsed.version)) {
    findings.push({
      severity: "error",
      field: "version",
      message: `Version "${parsed.version}" is not a valid semver format. Expected X.Y.Z or X.Y.Z-prerelease.`,
    });
  }
}

/**
 * Validate the files array.
 */
function validateFiles(parsed: ParsedUpdateMetadata, findings: SchemaValidationFinding[]): void {
  if (!parsed.files || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    findings.push({
      severity: "error",
      field: "files",
      message: "Required field 'files' is missing, not an array, or empty. At least one file entry is required.",
    });
    return;
  }

  for (let i = 0; i < parsed.files.length; i++) {
    const file = parsed.files[i];
    const prefix = `files[${i}]`;

    // URL/filename
    if (!file.url) {
      findings.push({
        severity: "error",
        field: `${prefix}.url`,
        message: `File entry ${i} is missing required 'url' field.`,
      });
    }

    // SHA-512 (base64)
    if (!file.sha512) {
      findings.push({
        severity: "error",
        field: `${prefix}.sha512`,
        message: `File entry ${i} is missing required 'sha512' field. electron-updater requires SHA-512 in base64 format.`,
      });
    } else if (!isValidBase64Sha512(file.sha512)) {
      findings.push({
        severity: "error",
        field: `${prefix}.sha512`,
        message: `File entry ${i} has invalid SHA-512 hash. Must be base64-encoded (88 characters). Got ${file.sha512.length} chars.`,
      });
    }

    // Size
    if (file.size === undefined || file.size === null) {
      findings.push({
        severity: "error",
        field: `${prefix}.size`,
        message: `File entry ${i} is missing required 'size' field.`,
      });
    } else if (typeof file.size !== "number" || file.size <= 0) {
      findings.push({
        severity: "error",
        field: `${prefix}.size`,
        message: `File entry ${i} has invalid size: ${file.size}. Must be a positive number.`,
      });
    }
  }
}

/**
 * Validate the deprecated but required path field.
 */
function validatePath(parsed: ParsedUpdateMetadata, findings: SchemaValidationFinding[]): void {
  if (!parsed.path) {
    findings.push({
      severity: "error",
      field: "path",
      message: "Required field 'path' is missing. Although deprecated in electron-updater, it is still required for compatibility.",
    });
  } else {
    // Check that the path references a file in the files array
    const fileUrls = parsed.files.map((f) => {
      const parts = f.url.split("/");
      return parts[parts.length - 1];
    });

    if (!fileUrls.includes(parsed.path)) {
      findings.push({
        severity: "warning",
        field: "path",
        message: `Path "${parsed.path}" does not match any file URL in the files array. This may cause update issues.`,
      });
    }
  }
}

/**
 * Validate the deprecated but required sha512 field.
 */
function validateSha512(parsed: ParsedUpdateMetadata, findings: SchemaValidationFinding[]): void {
  if (!parsed.sha512) {
    findings.push({
      severity: "error",
      field: "sha512",
      message: "Required field 'sha512' is missing. Although deprecated in electron-updater, it is still required for compatibility.",
    });
  } else if (!isValidBase64Sha512(parsed.sha512)) {
    findings.push({
      severity: "error",
      field: "sha512",
      message: `Top-level sha512 is not valid base64-encoded SHA-512. Got ${parsed.sha512.length} chars, expected 88.`,
    });
  }
}

/**
 * Validate the releaseDate field.
 */
function validateReleaseDate(parsed: ParsedUpdateMetadata, findings: SchemaValidationFinding[]): void {
  if (!parsed.releaseDate) {
    findings.push({
      severity: "error",
      field: "releaseDate",
      message: "Required field 'releaseDate' is missing.",
    });
    return;
  }

  // Validate ISO 8601 format
  const iso8601Regex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?)?$/;
  if (!iso8601Regex.test(parsed.releaseDate)) {
    findings.push({
      severity: "warning",
      field: "releaseDate",
      message: `Release date "${parsed.releaseDate}" may not be in ISO 8601 format. Expected format: YYYY-MM-DDTHH:MM:SS.sssZ`,
    });
  }
}

// ─── YAML Parser ────────────────────────────────────────────────────────────

/**
 * Parse a simple YAML document into a ParsedUpdateMetadata object.
 *
 * This is a minimal parser for the known latest-linux.yml format.
 * It does not handle all YAML features, only the subset used by
 * electron-updater's update metadata.
 */
export function parseUpdateYaml(content: string): ParsedUpdateMetadata {
  const lines = content.split("\n");
  const result: Partial<ParsedUpdateMetadata> = {
    files: [],
  };

  let currentFile: Partial<ParsedUpdateFile> | null = null;
  let inFiles = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Top-level fields
    if (line.startsWith("version:")) {
      result.version = extractYamlValue(line.substring("version:".length));
      inFiles = false;
    } else if (line.startsWith("path:")) {
      result.path = extractYamlValue(line.substring("path:".length));
      inFiles = false;
    } else if (line.startsWith("sha512:") && !rawLine.startsWith("    ")) {
      result.sha512 = extractYamlValue(line.substring("sha512:".length));
      inFiles = false;
    } else if (line.startsWith("releaseDate:")) {
      result.releaseDate = extractYamlValue(line.substring("releaseDate:".length));
      inFiles = false;
    } else if (line.startsWith("releaseName:")) {
      result.releaseName = extractYamlValue(line.substring("releaseName:".length));
      inFiles = false;
    } else if (line.startsWith("releaseNotes:")) {
      result.releaseNotes = extractYamlValue(line.substring("releaseNotes:".length));
      inFiles = false;
    } else if (line.startsWith("channel:")) {
      result.channel = extractYamlValue(line.substring("channel:".length));
      inFiles = false;
    } else if (line === "files:") {
      inFiles = true;
    } else if (inFiles && line.startsWith("- url:")) {
      // New file entry
      if (currentFile && currentFile.url !== undefined) {
        result.files!.push(currentFile as ParsedUpdateFile);
      }
      currentFile = { url: extractYamlValue(line.substring("- url:".length)) };
    } else if (inFiles && currentFile && line.startsWith("url:")) {
      currentFile.url = extractYamlValue(line.substring("url:".length));
    } else if (inFiles && currentFile && line.startsWith("sha512:")) {
      currentFile.sha512 = extractYamlValue(line.substring("sha512:".length));
    } else if (inFiles && currentFile && line.startsWith("size:")) {
      const sizeStr = extractYamlValue(line.substring("size:".length));
      currentFile.size = parseInt(sizeStr, 10);
    }
  }

  // Push the last file entry
  if (currentFile && currentFile.url !== undefined) {
    result.files!.push(currentFile as ParsedUpdateFile);
  }

  // Validate required fields
  if (!result.version) {
    throw new Error("Missing required field: version");
  }
  if (!result.files || result.files.length === 0) {
    throw new Error("Missing required field: files (must have at least one entry)");
  }
  if (!result.path) {
    throw new Error("Missing required field: path");
  }
  if (!result.sha512) {
    throw new Error("Missing required field: sha512");
  }
  if (!result.releaseDate) {
    throw new Error("Missing required field: releaseDate");
  }

  return result as ParsedUpdateMetadata;
}

/**
 * Extract a value from a YAML key: value line, handling quotes.
 */
function extractYamlValue(raw: string): string {
  let value = raw.trim();

  // Remove surrounding quotes
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))) {
    value = value.substring(1, value.length - 1);
  }

  return value;
}

/**
 * Check if a string looks like a valid base64-encoded SHA-512 hash.
 * SHA-512 produces 64 bytes = 88 base64 characters (with padding).
 */
function isValidBase64Sha512(value: string): boolean {
  // Base64 SHA-512 is 88 characters (64 bytes -> 88 base64 chars with padding)
  // Or 86 characters without padding
  return /^[A-Za-z0-9+/]{86,88}={0,2}$/.test(value);
}

/**
 * Format a SchemaValidationResult for display.
 */
export function formatSchemaValidationResult(result: SchemaValidationResult): string {
  const lines: string[] = [];

  lines.push("=== Updater Schema Validation ===");
  lines.push(`Status: ${result.valid ? "PASS" : "FAIL"}`);
  lines.push(`Errors: ${result.errorCount}`);
  lines.push(`Warnings: ${result.warningCount}`);

  if (result.parsed) {
    lines.push(`Version: ${result.parsed.version}`);
    lines.push(`Files: ${result.parsed.files.length}`);
    lines.push(`Release date: ${result.parsed.releaseDate}`);
  }

  for (const finding of result.findings) {
    const icon = finding.severity === "error" ? "✗" : "⚠";
    lines.push(`  ${icon} [${finding.field}] ${finding.message}`);
  }

  return lines.join("\n");
}
