/**
 * Tests for the about-panel patch.
 *
 * Validates that the about-panel patch correctly augments the "About Factory"
 * dialog's detail template literal to read build-info.json and state.json at
 * runtime, and degrades gracefully when files are missing.
 */

import {
  patchAboutPanel,
  validateAboutPanel,
  formatAboutPanelPatchResult,
} from "../src/about-panel-patch";

// ─── Minified code samples from real Factory Desktop 0.114.3 asar ──────────

/**
 * The exact About Factory detail string from Factory Desktop 0.114.3.
 * Vite minification converts `\n` escapes to actual newline characters inside
 * backtick template literals. The alias `Y` = require("electron").
 */
const ABOUT_DETAIL_0_114_3 =
  'detail:`Version: ${Y.app.getVersion()}\n' +
  'Electron: ${process.versions.electron}\n' +
  'Chromium: ${process.versions.chrome}\n' +
  'Node.js: ${process.versions.node}`';

/**
 * A variant with a different minified alias (e.g. `e` instead of `Y`).
 */
const ABOUT_DETAIL_ALT_ALIAS =
  'detail:`Version: ${e.app.getVersion()}\n' +
  'Electron: ${process.versions.electron}\n' +
  'Chromium: ${process.versions.chrome}\n' +
  'Node.js: ${process.versions.node}`';

// ─── Version-agnostic regex matching ──────────────────────────────────────

const ABOUT_DETAIL_REGEX =
  /detail:`Version:\s*\$\{(\w+\.app\.getVersion\(\))\}\nElectron:\s*\$\{process\.versions\.electron\}\nChromium:\s*\$\{process\.versions\.chrome\}\nNode\.js:\s*\$\{process\.versions\.node\}`/;

describe("about-panel-patch version-agnostic matching", () => {
  it("matches Factory 0.114.3 About detail pattern", () => {
    expect(ABOUT_DETAIL_0_114_3).toMatch(ABOUT_DETAIL_REGEX);
  });

  it("extracts the getVersion reference (alias Y)", () => {
    const match = ABOUT_DETAIL_0_114_3.match(ABOUT_DETAIL_REGEX);
    expect(match?.[1]).toBe("Y.app.getVersion()");
  });

  it("matches alternative alias names", () => {
    expect(ABOUT_DETAIL_ALT_ALIAS).toMatch(ABOUT_DETAIL_REGEX);
    const match = ABOUT_DETAIL_ALT_ALIAS.match(ABOUT_DETAIL_REGEX);
    expect(match?.[1]).toBe("e.app.getVersion()");
  });

  it("does not match without the Node.js line", () => {
    const noNode =
      'detail:`Version: ${Y.app.getVersion()}\n' +
      'Electron: ${process.versions.electron}\n' +
      'Chromium: ${process.versions.chrome}`';
    expect(noNode).not.toMatch(ABOUT_DETAIL_REGEX);
  });
});

// ─── patchAboutPanel ──────────────────────────────────────────────────────

describe("patchAboutPanel", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require("fs");
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  it("returns error when asar not found", async () => {
    const result = await patchAboutPanel({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.success).toBe(false);
    expect(result.patched).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });

  it("returns success with tolerateMissingTarget when no bundles found", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-" + Date.now();
    tmpDirs.push(tmpDir);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "placeholder.txt"), "test");
    const asarPath = path.join(tmpDir, "test.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchAboutPanel({
      asarPath,
      tolerateMissingTarget: true,
    });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(false);
  });

  it("patches a bundle containing the About Factory detail string", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-patch-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    // Write a minimal bundle containing both the About Factory dialog and
    // the renderer did-finish-load hook used for the visible version chip.
    const bundleContent =
      'function gu(){const e=process.platform==="darwin";' +
      'const s=[{label:"Help",submenu:[{label:"About Factory",click:()=>{' +
      ABOUT_DETAIL_0_114_3 +
      '}}]}];Y.Menu.setApplicationMenu(Y.Menu.buildFromTemplate(s))}' +
      'function createWindow(){_t.webContents.on("did-finish-load",()=>{me("[window] Renderer finished loading")})}';
    fs.writeFileSync(
      path.join(buildDir, "index-AbCdEfGh.js"),
      bundleContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchAboutPanel({ asarPath });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(true);
    expect(result.patchCount).toBe(1);
    expect(result.errors).toEqual([]);

    // Verify the patched content
    const patchedContent = asar
      .extractFile(asarPath, ".vite/build/index-AbCdEfGh.js")
      .toString("utf-8");

    // Should contain the PATCH_MARKER
    expect(patchedContent).toContain("/* linux-about-panel-patch */");

    // Should NOT contain the original detail template literal
    expect(patchedContent).not.toContain("detail:`Version: ${Y.app.getVersion()}");

    // Should contain the runtime IIFE
    expect(patchedContent).toContain("detail:(()=>{");

    expect(patchedContent).not.toContain("/* linux-visible-version-chip-patch */");
    expect(patchedContent).not.toContain("factory-linux-version-chip");
    expect(patchedContent).toContain("System Droid CLI");
    expect(patchedContent).not.toContain("System Droid CLI not found");
    expect(patchedContent).not.toContain("System daemon running");
    expect(patchedContent).not.toContain("System daemon not running");
    expect(patchedContent).toContain("s.error_message");
    expect(patchedContent).not.toContain("Remote daemon");
    expect(patchedContent).not.toContain("factory-droid-daemon.service");
    expect(patchedContent).not.toContain("droid-remote-access.service");
    expect(patchedContent).not.toContain("process.kill(Number(pid)");
    expect(patchedContent).toContain("cv&&cv!==v");
    expect(patchedContent).toContain("cv===v");
  });

  it("skips already-patched bundles", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-skip-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    // Write a fully patched bundle (About dialog + visible chip).
    const patchedContent =
      'function gu(){const s=[{label:"About Factory",click:()=>{' +
      'detail:(()=>{/* linux-about-panel-patch */try{const p=require("path")}})()' +
      '}}]}];Y.Menu.setApplicationMenu(Y.Menu.buildFromTemplate(s))}' +
      'function createWindow(){_t.webContents.on("did-finish-load",()=>{/* linux-visible-version-chip-patch */try{}})}';
    fs.writeFileSync(
      path.join(buildDir, "index-AbCdEfGh.js"),
      patchedContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchAboutPanel({ asarPath });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(false);
    expect(result.patchCount).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("already patched")]),
    );
  });

  it("patches with alternative alias names", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-alt-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    const bundleContent =
      'function gu(){const s=[{label:"About Factory",click:()=>{' +
      ABOUT_DETAIL_ALT_ALIAS +
      '}}]}];e.Menu.setApplicationMenu(e.Menu.buildFromTemplate(s))}';
    fs.writeFileSync(
      path.join(buildDir, "index-XyZwVuTs.js"),
      bundleContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = await patchAboutPanel({ asarPath });

    expect(result.success).toBe(true);
    expect(result.patched).toBe(true);
    expect(result.patchCount).toBe(1);

    const patchedContent = asar
      .extractFile(asarPath, ".vite/build/index-XyZwVuTs.js")
      .toString("utf-8");

    expect(patchedContent).toContain("/* linux-about-panel-patch */");
    // Should use the alternative alias in the IIFE
    expect(patchedContent).toContain("e.app.getVersion()");
  });
});

// ─── validateAboutPanel ───────────────────────────────────────────────────

describe("validateAboutPanel", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require("fs");
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  it("returns error when asar not found", () => {
    const result = validateAboutPanel({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.valid).toBe(false);
    expect(result.aboutPanelPatched).toBe(false);
    expect(result.visibleVersionChipPatched).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });

  it("detects patched asar", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-val-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    const patchedContent =
      '/* linux-about-panel-patch */ detail:(()=>{try{...}})()';
    fs.writeFileSync(
      path.join(buildDir, "index-AbCdEfGh.js"),
      patchedContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = validateAboutPanel({ asarPath });
    expect(result.valid).toBe(true);
    expect(result.aboutPanelPatched).toBe(true);
    expect(result.visibleVersionChipPatched).toBe(false);
  });

  it("detects unpatched asar", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */

    const tmpDir = expect.getState().testPath + ".tmp-unp-" + Date.now();
    tmpDirs.push(tmpDir);
    const buildDir = path.join(tmpDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });

    const unpatchedContent =
      'detail:`Version: ${Y.app.getVersion()}\nElectron: ${process.versions.electron}`';
    fs.writeFileSync(
      path.join(buildDir, "index-AbCdEfGh.js"),
      unpatchedContent,
    );

    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    const result = validateAboutPanel({ asarPath });
    expect(result.valid).toBe(false);
    expect(result.aboutPanelPatched).toBe(false);
    expect(result.visibleVersionChipPatched).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("About dialog version patch marker not found"),
      ]),
    );
  });
});

// ─── Formatting ──────────────────────────────────────────────────────────

describe("formatAboutPanelPatchResult", () => {
  it("formats a successful result", () => {
    const result = {
      success: true,
      patched: true,
      originalHash: "abc123",
      patchedHash: "def456",
      patchCount: 1,
      patches: [
        {
          id: "linux-about-panel-version",
          description: "test description",
          originalSnippet: "original",
          replacementSnippet: "replacement",
        },
      ],
      errors: [],
      warnings: [],
    };
    const formatted = formatAboutPanelPatchResult(result);
    expect(formatted).toContain("✓ success");
    expect(formatted).toContain("Patch count: 1");
    expect(formatted).toContain("test description");
  });

  it("formats a failed result", () => {
    const result = {
      success: false,
      patched: false,
      originalHash: "abc123",
      patchedHash: "abc123",
      patchCount: 0,
      patches: [],
      errors: ["test error"],
      warnings: [],
    };
    const formatted = formatAboutPanelPatchResult(result);
    expect(formatted).toContain("✗ failed");
    expect(formatted).toContain("test error");
  });
});
