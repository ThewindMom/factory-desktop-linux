/**
 * Tests for tool availability checks.
 */

import { checkTool, checkAllTools, assertRequiredTools, REQUIRED_TOOLS } from "../src/tool-check";
import { parseMajorVersion } from "../src/tool-check";

describe("checkTool", () => {
  it("finds node as available", () => {
    const nodeTool = REQUIRED_TOOLS.find((t) => t.name === "node")!;
    const result = checkTool(nodeTool);
    expect(result.available).toBe(true);
    expect(result.version).toContain("v");
  });

  it("finds 7z as available", () => {
    const sevenZip = REQUIRED_TOOLS.find((t) => t.name === "7z")!;
    const result = checkTool(sevenZip);
    expect(result.available).toBe(true);
  });

  it("reports unavailable tool", () => {
    const fakeTool = {
      name: "nonexistent_tool_xyz_12345",
      description: "Test tool that does not exist",
      required: false,
    };
    const result = checkTool(fakeTool);
    expect(result.available).toBe(false);
  });
});

describe("parseMajorVersion", () => {
  it("parses 7-Zip 16.02 format", () => {
    expect(parseMajorVersion("7-Zip [64] 16.02 : Copyright (c) 1999-2016 Igor Pavlov : 2016-05-21")).toBe(16);
  });

  it("parses 7-Zip 26.01 format", () => {
    expect(parseMajorVersion("7-Zip (z) 26.01 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-04-27")).toBe(26);
  });

  it("parses 7-Zip 23.01 format", () => {
    expect(parseMajorVersion("7-Zip 23.01 (x64) : Copyright (c) 1999-2023 Igor Pavlov : 2023-06-20")).toBe(23);
  });

  it("parses 7-Zip 21.07 format (Ubuntu 22.04 7zip package)", () => {
    expect(parseMajorVersion("7-Zip (z) 21.07 (x64) : Copyright (c) 1999-2021 Igor Pavlov : 2021-12-26")).toBe(21);
  });

  it("parses 7-Zip 16.02 format (p7zip — too old)", () => {
    expect(parseMajorVersion("7-Zip [64] 16.02 : Copyright (c) 1999-2016 Igor Pavlov : 2016-05-21")).toBe(16);
  });

  it("parses Node v22 format", () => {
    expect(parseMajorVersion("v22.0.0")).toBe(22);
  });

  it("returns undefined for non-version output", () => {
    expect(parseMajorVersion("some text without version")).toBeUndefined();
  });
});

describe("checkTool minVersion enforcement", () => {
  it("7z tool definition requires minVersion 21", () => {
    const sevenZip = REQUIRED_TOOLS.find((t) => t.name === "7z")!;
    expect(sevenZip.minVersion).toBe("21");
  });

  it("reports available when 7z version meets minimum", () => {
    // On this dev machine 7z should be >= 21
    const sevenZip = REQUIRED_TOOLS.find((t) => t.name === "7z")!;
    const result = checkTool(sevenZip);
    expect(result.available).toBe(true);
    const detected = parseMajorVersion(result.version || "");
    expect(detected).toBeGreaterThanOrEqual(21);
  });
});

describe("checkAllTools", () => {
  it("returns results for all defined tools", () => {
    const { results } = checkAllTools();
    expect(results.length).toBe(REQUIRED_TOOLS.length);
  });

  it("required tools (node, npm, 7z) are available", () => {
    const { results } = checkAllTools();
    const requiredResults = results.filter((r) => {
      const tool = REQUIRED_TOOLS.find((t) => t.name === r.tool);
      return tool?.required;
    });

    for (const result of requiredResults) {
      expect(result.available).toBe(true);
    }
  });

  it("rpmbuild availability matches host", () => {
    const { results } = checkAllTools();
    const rpm = results.find((r) => r.tool === "rpmbuild");
    // rpmbuild may or may not be installed — just verify the check ran
    expect(rpm).toBeDefined();
    expect(typeof rpm?.available).toBe("boolean");
  });
});

describe("assertRequiredTools", () => {
  it("does not throw when required tools are available", () => {
    expect(() => assertRequiredTools()).not.toThrow();
  });
});
