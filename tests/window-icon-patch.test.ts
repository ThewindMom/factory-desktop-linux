/**
 * Tests for the Linux window icon patch.
 *
 * The panel/taskbar window button must show Factory's logo; without an
 * explicit BrowserWindow icon Linux draws the generic window glyph.
 */

import * as fs from "fs";
import * as path from "path";
import {
  patchWindowIcon,
  validateWindowIcon,
  WINDOW_ICON_PATCH_MARKER,
} from "../src/window-icon-patch";

const WINDOW_BUNDLE_1_3_0 =
  'function Kn(e){const t=new Y.BrowserWindow({titleBarStyle:r?"default":"hidden",' +
  'width:1200,height:800,show:!1});return t.loadURL("index.html"),t}';

async function makeAsar(bundleSource: string): Promise<{
  asarPath: string;
  cleanup: () => void;
}> {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const asar = require("@electron/asar");
  /* eslint-enable @typescript-eslint/no-var-requires */

  const tmpDir = path.join(
    __dirname,
    ".tmp-winicon-" + process.pid + "-" + Date.now(),
  );
  const bundleDir = path.join(tmpDir, "src", ".vite", "build");
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "index-abc123.js"), bundleSource);

  const asarPath = path.join(tmpDir, "app.asar");
  await asar.createPackage(path.join(tmpDir, "src"), asarPath);

  return {
    asarPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe("patchWindowIcon", () => {
  it("returns an error when the asar is missing", async () => {
    const result = await patchWindowIcon({ asarPath: "/nonexistent/app.asar" });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("not found");
  });

  it("injects the icon option into BrowserWindow and is idempotent", async () => {
    const { asarPath, cleanup } = await makeAsar(WINDOW_BUNDLE_1_3_0);
    try {
      const first = await patchWindowIcon({ asarPath });
      expect(first.success).toBe(true);
      expect(first.patched).toBe(true);
      expect(first.patchCount).toBe(1);

      /* eslint-disable @typescript-eslint/no-var-requires */
      const asar = require("@electron/asar");
      /* eslint-enable @typescript-eslint/no-var-requires */
      const patched = asar
        .extractFile(asarPath, ".vite/build/index-abc123.js")
        .toString("utf-8");

      expect(patched).toContain(WINDOW_ICON_PATCH_MARKER);
      expect(patched).toContain("factory-icon.png");
      expect(patched).toContain("process.resourcesPath");
      // Original options must survive the injection.
      expect(patched).toContain('width:1200,height:800,show:!1');

      const second = await patchWindowIcon({ asarPath });
      expect(second.success).toBe(true);
      expect(second.patched).toBe(false);

      expect(validateWindowIcon({ asarPath }).windowIconPatched).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("tolerates bundles without a BrowserWindow", async () => {
    const { asarPath, cleanup } = await makeAsar("function x(){return 1}");
    try {
      const result = await patchWindowIcon({
        asarPath,
        tolerateMissingTarget: true,
      });
      expect(result.success).toBe(true);
      expect(result.patched).toBe(false);
    } finally {
      cleanup();
    }
  });
});
