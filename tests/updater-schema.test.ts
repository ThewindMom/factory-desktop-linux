/**
 * Tests for updater-schema module: validates generated Linux update metadata
 * against the electron-updater UpdateInfo schema.
 *
 * Fulfills: VAL-PACKAGE-012
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
  validateUpdaterSchema,
  parseUpdateYaml,
  formatSchemaValidationResult,
} from "../src/updater-schema";
import { LINUX_UPDATE_METADATA_FILENAME } from "../src/release-metadata";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `factory-updater-schema-${prefix}-`));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Create a valid latest-linux.yml content string */
function createValidYamlContent(overrides?: {
  version?: string;
  sha512Base64?: string;
  fileSize?: number;
  releaseDate?: string;
}): string {
  const sha512Base64 = overrides?.sha512Base64 ||
    Buffer.from(crypto.randomBytes(64)).toString("base64");
  const fileSize = overrides?.fileSize !== undefined ? overrides.fileSize : 123456789;

  return [
    `version: ${overrides?.version || "0.106.0"}`,
    `files:`,
    `  - url: Factory-0.106.0.AppImage`,
    `    sha512: ${sha512Base64}`,
    `    size: ${fileSize}`,
    `path: Factory-0.106.0.AppImage`,
    `sha512: ${sha512Base64}`,
    `releaseDate: '${overrides?.releaseDate || "2024-01-01T00:00:00.000Z"}'`,
  ].join("\n") + "\n";
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("updater-schema", () => {
  describe("parseUpdateYaml", () => {
    test("parses valid latest-linux.yml content", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = createValidYamlContent({ sha512Base64: sha512 });

      const result = parseUpdateYaml(content);

      expect(result.version).toBe("0.106.0");
      expect(result.files).toHaveLength(1);
      expect(result.files[0].url).toBe("Factory-0.106.0.AppImage");
      expect(result.files[0].sha512).toBe(sha512);
      expect(result.files[0].size).toBe(123456789);
      expect(result.path).toBe("Factory-0.106.0.AppImage");
      expect(result.sha512).toBe(sha512);
      expect(result.releaseDate).toBe("2024-01-01T00:00:00.000Z");
    });

    test("parses YAML with multiple file entries", () => {
      const sha512_1 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const sha512_2 = Buffer.from(crypto.randomBytes(64)).toString("base64");

      const content = [
        "version: 0.106.0",
        "files:",
        "  - url: Factory-0.106.0.AppImage",
        `    sha512: ${sha512_1}`,
        "    size: 123456789",
        "  - url: factory-desktop_0.106.0_amd64.deb",
        `    sha512: ${sha512_2}`,
        "    size: 98765432",
        "path: Factory-0.106.0.AppImage",
        `sha512: ${sha512_1}`,
        "releaseDate: '2024-01-01T00:00:00.000Z'",
      ].join("\n") + "\n";

      const result = parseUpdateYaml(content);

      expect(result.files).toHaveLength(2);
      expect(result.files[0].url).toBe("Factory-0.106.0.AppImage");
      expect(result.files[1].url).toBe("factory-desktop_0.106.0_amd64.deb");
    });

    test("throws for missing version", () => {
      const content = [
        "files:",
        "  - url: test.AppImage",
        "    sha512: abc",
        "    size: 100",
        "path: test.AppImage",
        "sha512: abc",
        "releaseDate: '2024-01-01'",
      ].join("\n") + "\n";

      expect(() => parseUpdateYaml(content)).toThrow("version");
    });

    test("throws for missing files", () => {
      const content = [
        "version: 0.106.0",
        "path: test.AppImage",
        "sha512: abc",
        "releaseDate: '2024-01-01'",
      ].join("\n") + "\n";

      expect(() => parseUpdateYaml(content)).toThrow("files");
    });

    test("throws for missing path", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = [
        "version: 0.106.0",
        "files:",
        "  - url: test.AppImage",
        `    sha512: ${sha512}`,
        "    size: 100",
        `sha512: ${sha512}`,
        "releaseDate: '2024-01-01'",
      ].join("\n") + "\n";

      expect(() => parseUpdateYaml(content)).toThrow("path");
    });

    test("throws for missing sha512", () => {
      const content = [
        "version: 0.106.0",
        "files:",
        "  - url: test.AppImage",
        "    sha512: abc",
        "    size: 100",
        "path: test.AppImage",
        "releaseDate: '2024-01-01'",
      ].join("\n") + "\n";

      expect(() => parseUpdateYaml(content)).toThrow("sha512");
    });

    test("throws for missing releaseDate", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = [
        "version: 0.106.0",
        "files:",
        "  - url: test.AppImage",
        `    sha512: ${sha512}`,
        "    size: 100",
        "path: test.AppImage",
        `sha512: ${sha512}`,
      ].join("\n") + "\n";

      expect(() => parseUpdateYaml(content)).toThrow("releaseDate");
    });
  });

  describe("validateUpdaterSchema", () => {
    test("passes for valid updater metadata", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = createValidYamlContent({ sha512Base64: sha512 });

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(true);
      expect(result.errorCount).toBe(0);
    });

    test("fails for missing version", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = [
        "files:",
        "  - url: test.AppImage",
        `    sha512: ${sha512}`,
        "    size: 100",
        "path: test.AppImage",
        `sha512: ${sha512}`,
        "releaseDate: '2024-01-01T00:00:00.000Z'",
      ].join("\n") + "\n";

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "yaml",
          }),
        ])
      );
    });

    test("fails for invalid version format", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = createValidYamlContent({
        version: "not-semver",
        sha512Base64: sha512,
      });

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "version",
          }),
        ])
      );
    });

    test("fails for missing SHA-512 in file entry", () => {
      const content = [
        "version: 0.106.0",
        "files:",
        "  - url: test.AppImage",
        "    size: 100",
        "path: test.AppImage",
        `sha512: ${Buffer.from(crypto.randomBytes(64)).toString("base64")}`,
        "releaseDate: '2024-01-01T00:00:00.000Z'",
      ].join("\n") + "\n";

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: expect.stringContaining("sha512"),
          }),
        ])
      );
    });

    test("fails for invalid base64 SHA-512", () => {
      const content = createValidYamlContent({ sha512Base64: "not-valid-base64" });

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: expect.stringContaining("sha512"),
          }),
        ])
      );
    });

    test("fails for missing size in file entry", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = [
        "version: 0.106.0",
        "files:",
        "  - url: test.AppImage",
        `    sha512: ${sha512}`,
        "path: test.AppImage",
        `sha512: ${sha512}`,
        "releaseDate: '2024-01-01T00:00:00.000Z'",
      ].join("\n") + "\n";

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: expect.stringContaining("size"),
          }),
        ])
      );
    });

    test("fails for zero or negative size", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = createValidYamlContent({ sha512Base64: sha512, fileSize: 0 });

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: expect.stringContaining("size"),
          }),
        ])
      );
    });

    test("fails for missing path field", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = [
        "version: 0.106.0",
        "files:",
        "  - url: test.AppImage",
        `    sha512: ${sha512}`,
        "    size: 100",
        `sha512: ${sha512}`,
        "releaseDate: '2024-01-01T00:00:00.000Z'",
      ].join("\n") + "\n";

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(false);
    });

    test("fails for missing top-level sha512", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = [
        "version: 0.106.0",
        "files:",
        "  - url: test.AppImage",
        `    sha512: ${sha512}`,
        "    size: 100",
        "path: test.AppImage",
        "releaseDate: '2024-01-01T00:00:00.000Z'",
      ].join("\n") + "\n";

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(false);
    });

    test("fails for missing releaseDate", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = [
        "version: 0.106.0",
        "files:",
        "  - url: test.AppImage",
        `    sha512: ${sha512}`,
        "    size: 100",
        "path: test.AppImage",
        `sha512: ${sha512}`,
      ].join("\n") + "\n";

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(false);
    });

    test("validates metadata from file path", () => {
      const tempDir = createTempDir("file-validate");
      try {
        const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
        const content = createValidYamlContent({ sha512Base64: sha512 });
        const metadataPath = path.join(tempDir, LINUX_UPDATE_METADATA_FILENAME);
        fs.writeFileSync(metadataPath, content);

        const result = validateUpdaterSchema({ metadataPath });

        expect(result.valid).toBe(true);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    test("fails for nonexistent file path", () => {
      const result = validateUpdaterSchema({
        metadataPath: "/nonexistent/latest-linux.yml",
      });

      expect(result.valid).toBe(false);
      expect(result.errorCount).toBe(1);
    });

    test("fails when neither path nor content provided", () => {
      const result = validateUpdaterSchema({});

      expect(result.valid).toBe(false);
      expect(result.errorCount).toBe(1);
    });

    test("generic YAML that is not updater-compatible should fail", () => {
      // VAL-PACKAGE-012: Metadata must not just validate as generic YAML
      // but must satisfy the updater schema
      const content = [
        "name: test",
        "description: a description",
        "items:",
        "  - foo",
        "  - bar",
      ].join("\n") + "\n";

      const result = validateUpdaterSchema({ metadataContent: content });

      expect(result.valid).toBe(false);
    });

    test("warns when path does not match any file URL", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = [
        "version: 0.106.0",
        "files:",
        "  - url: Factory-0.106.0.AppImage",
        `    sha512: ${sha512}`,
        "    size: 100",
        "path: DifferentFile.AppImage",
        `sha512: ${sha512}`,
        "releaseDate: '2024-01-01T00:00:00.000Z'",
      ].join("\n") + "\n";

      const result = validateUpdaterSchema({ metadataContent: content });

      // Path mismatch is a warning, not an error
      expect(result.warningCount).toBeGreaterThan(0);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "warning",
            field: "path",
          }),
        ])
      );
    });
  });

  describe("formatSchemaValidationResult", () => {
    test("formats valid result", () => {
      const sha512 = Buffer.from(crypto.randomBytes(64)).toString("base64");
      const content = createValidYamlContent({ sha512Base64: sha512 });
      const result = validateUpdaterSchema({ metadataContent: content });
      const formatted = formatSchemaValidationResult(result);

      expect(formatted).toContain("PASS");
      expect(formatted).toContain("0.106.0");
    });

    test("formats invalid result", () => {
      const result = validateUpdaterSchema({ metadataContent: "invalid" });
      const formatted = formatSchemaValidationResult(result);

      expect(formatted).toContain("FAIL");
    });
  });
});
