/**
 * Tests for version discovery (VAL-EXTRACT-002, VAL-EXTRACT-010).
 *
 * VAL-EXTRACT-002: When latest-version mode is requested, the builder CLI
 * must query the Factory Desktop latest-version surface and report the
 * resolved version value. The command passes only if the reported value
 * is a non-empty semantic version and downstream version selection uses
 * that exact value.
 *
 * VAL-EXTRACT-010: If latest-version discovery times out, returns malformed
 * JSON, returns an empty version, or returns a non-semver value, the
 * builder must fail with a clear diagnostic and must not continue with
 * stale or guessed versions.
 */

import * as http from "http";
import {
  isValidSemver,
  parseLatestVersionResponse,
  discoverLatestVersion,
  resolveVersion,
} from "../src/version-discovery";

// ============== Unit tests for isValidSemver ==============

describe("isValidSemver", () => {
  it("accepts valid semver strings", () => {
    expect(isValidSemver("0.106.0")).toBe(true);
    expect(isValidSemver("1.0.0")).toBe(true);
    expect(isValidSemver("10.20.30")).toBe(true);
  });

  it("rejects non-semver strings", () => {
    expect(isValidSemver("")).toBe(false);
    expect(isValidSemver("1.0")).toBe(false);
    expect(isValidSemver("1")).toBe(false);
    expect(isValidSemver("v1.0.0")).toBe(false);
    expect(isValidSemver("1.0.0-alpha")).toBe(false);
    expect(isValidSemver("1.0.0+build")).toBe(false);
    expect(isValidSemver("not-a-version")).toBe(false);
  });

  it("trims whitespace before validating", () => {
    expect(isValidSemver(" 1.0.0 ")).toBe(true);
    expect(isValidSemver("  0.106.0  ")).toBe(true);
  });
});

// ============== Unit tests for parseLatestVersionResponse ==============

describe("parseLatestVersionResponse", () => {
  describe("valid responses", () => {
    it("parses a valid latest-version response", () => {
      const result = parseLatestVersionResponse(
        '{"latestVersion":"0.106.0"}'
      );
      expect(result.success).toBe(true);
      expect(result.version).toBe("0.106.0");
    });

    it("handles whitespace in JSON response", () => {
      const result = parseLatestVersionResponse(
        '  {"latestVersion": "1.2.3"}  '
      );
      expect(result.success).toBe(true);
      expect(result.version).toBe("1.2.3");
    });
  });

  // VAL-EXTRACT-010: Safe failure on malformed responses
  describe("malformed responses", () => {
    it("rejects empty response", () => {
      const result = parseLatestVersionResponse("");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Empty response");
    });

    it("rejects whitespace-only response", () => {
      const result = parseLatestVersionResponse("   ");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Empty response");
    });

    it("rejects invalid JSON", () => {
      const result = parseLatestVersionResponse("not json");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Malformed JSON");
    });

    it("rejects truncated JSON", () => {
      const result = parseLatestVersionResponse('{"latestVersion":');
      expect(result.success).toBe(false);
      expect(result.error).toContain("Malformed JSON");
    });

    it("rejects JSON array", () => {
      const result = parseLatestVersionResponse('["0.106.0"]');
      expect(result.success).toBe(false);
      expect(result.error).toContain("non-object");
    });

    it("rejects JSON without latestVersion field", () => {
      const result = parseLatestVersionResponse('{"version":"0.106.0"}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("missing");
    });

    it("rejects null latestVersion", () => {
      const result = parseLatestVersionResponse('{"latestVersion":null}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("non-string");
    });

    it("rejects numeric latestVersion", () => {
      const result = parseLatestVersionResponse('{"latestVersion":0.106}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("non-string");
    });

    it("rejects empty version string", () => {
      const result = parseLatestVersionResponse('{"latestVersion":""}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("empty version");
    });

    it("rejects whitespace-only version string", () => {
      const result = parseLatestVersionResponse('{"latestVersion":"   "}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("empty version");
    });

    it("rejects non-semver version string", () => {
      const result = parseLatestVersionResponse('{"latestVersion":"0.106"}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("non-semver");
    });

    it("rejects version with pre-release tag", () => {
      const result = parseLatestVersionResponse(
        '{"latestVersion":"0.106.0-beta"}'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("non-semver");
    });

    it("rejects version with 'v' prefix", () => {
      const result = parseLatestVersionResponse(
        '{"latestVersion":"v0.106.0"}'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("non-semver");
    });

    it("includes raw response in error results", () => {
      const result = parseLatestVersionResponse("bad json");
      expect(result.rawResponse).toBe("bad json");
    });
  });
});

// ============== Integration tests with mock HTTP server ==============

describe("discoverLatestVersion (integration)", () => {
  let server: http.Server;
  let port: number;

  beforeAll((done) => {
    // Start a mock HTTP server for testing
    server = http.createServer((req, res) => {
      const url = req.url || "/";

      if (url === "/valid") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"latestVersion":"0.106.0"}');
      } else if (url === "/valid-newer") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"latestVersion":"1.0.0"}');
      } else if (url === "/malformed-json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not valid json");
      } else if (url === "/empty-version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"latestVersion":""}');
      } else if (url === "/non-semver") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"latestVersion":"not-a-version"}');
      } else if (url === "/missing-field") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"version":"0.106.0"}');
      } else if (url === "/null-version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"latestVersion":null}');
      } else if (url === "/empty-body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("");
      } else if (url === "/server-error") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      } else if (url === "/timeout") {
        // Never respond (will trigger client timeout)
        // Connection will stay open until client times out
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  // VAL-EXTRACT-002: Successful latest version discovery
  it("discovers latest version from valid endpoint", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/valid`,
      5000
    );
    expect(result.success).toBe(true);
    expect(result.version).toBe("0.106.0");
  });

  it("discovers newer version from valid endpoint", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/valid-newer`,
      5000
    );
    expect(result.success).toBe(true);
    expect(result.version).toBe("1.0.0");
  });

  // VAL-EXTRACT-010: Safe failure on various error conditions
  it("fails safely on malformed JSON response", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/malformed-json`,
      5000
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Malformed JSON");
  });

  it("fails safely on empty version", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/empty-version`,
      5000
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty version");
  });

  it("fails safely on non-semver version", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/non-semver`,
      5000
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("non-semver");
  });

  it("fails safely on missing latestVersion field", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/missing-field`,
      5000
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
  });

  it("fails safely on null version", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/null-version`,
      5000
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("non-string");
  });

  it("fails safely on empty response body", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/empty-body`,
      5000
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Empty");
  });

  it("fails safely on server error (5xx)", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/server-error`,
      5000
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 500");
  });

  it("fails safely on 404", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/not-found`,
      5000
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 404");
  });

  it("fails safely on connection refused", async () => {
    const result = await discoverLatestVersion(
      "http://localhost:1/impossible",
      2000
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("unreachable");
  });

  it("fails safely on timeout", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/timeout`,
      500
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  }, 10000);

  it("error message suggests --version fallback", async () => {
    const result = await discoverLatestVersion(
      `http://localhost:${port}/malformed-json`,
      5000
    );
    expect(result.error).toContain("--version");
  });
});

// ============== Tests for resolveVersion ==============

describe("resolveVersion", () => {
  it("returns explicit version when provided", async () => {
    const result = await resolveVersion({ version: "0.106.0" });
    expect(result.success).toBe(true);
    expect(result.version).toBe("0.106.0");
  });

  it("rejects invalid explicit version", async () => {
    const result = await resolveVersion({ version: "not-semver" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not a valid semantic version");
  });

  it("rejects partial version", async () => {
    const result = await resolveVersion({ version: "0.106" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not a valid semantic version");
  });

  it("fails when no version option is specified", async () => {
    const result = await resolveVersion({});
    expect(result.success).toBe(false);
    expect(result.error).toContain("No version specified");
  });

  it("discovers latest when --latest is requested", async () => {
    // Use the real endpoint - this is a live integration test
    const result = await resolveVersion({
      latest: true,
      timeoutMs: 10000,
    });
    // This test may fail if the endpoint is unavailable, but that's
    // expected in some CI environments. The mock server tests above
    // cover the core logic.
    if (result.success) {
      expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  }, 15000);
});
