/**
 * Tests for the Linux tray icon patch.
 *
 * The tray must show Factory's logo on Linux instead of the generated
 * monochrome glyph, which renders as a generic mark on XFCE/GNOME panels.
 */

import * as fs from "fs";
import * as path from "path";
import {
  patchTrayIcon,
  validateTrayIcon,
  TRAY_ICON_PATCH_MARKER,
} from "../src/tray-icon-patch";

/** Minified shape of the tray glyph factory in Factory Desktop 1.3.0. */
const TRAY_BUNDLE_1_3_0 =
  "function Mh(e,t=!1){const n=P0e(e===Ft.Offline),r=M0e(e),[o,i]=R0e[n]," +
  'a=Cs(`glyph:${n}`,()=>{const c=A.nativeImage.createFromDataURL(o);' +
  'return process.platform==="darwin"&&c.setTemplateImage(!0),c});' +
  "return!t&&!r?a:Cs(`glyph:${n}`,()=>O0e(a,t,r))}" +
  "this.tray=new A.Tray(Mh(Ft.Offline))";

async function makeTrayAsar(bundleSource: string): Promise<{
  asarPath: string;
  cleanup: () => void;
}> {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const asar = require("@electron/asar");
  /* eslint-enable @typescript-eslint/no-var-requires */

  const tmpDir = path.join(
    __dirname,
    ".tmp-tray-" + process.pid + "-" + Date.now(),
  );
  const bundleDir = path.join(tmpDir, "src", ".vite", "build");
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "initLifecycle-abc123.js"), bundleSource);
  fs.writeFileSync(path.join(tmpDir, "marker.txt"), "test");

  const asarPath = path.join(tmpDir, "app.asar");
  await asar.createPackage(path.join(tmpDir, "src"), asarPath);

  return {
    asarPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe("tray-icon-patch matching", () => {
  it("matches the 1.3.0 glyph factory shape", () => {
    const pattern =
      /function ([\w$]+)\(([\w$]+),([\w$]+)=!1\)\{const ([\w$]+)=([\w$]+)\(([\w$]+)===([\w$]+)\.Offline\)/;
    const match = TRAY_BUNDLE_1_3_0.match(pattern);
    expect(match?.[1]).toBe("Mh");
    expect(match?.[7]).toBe("Ft");
  });

  it("matches alternative minified names", () => {
    const pattern =
      /function ([\w$]+)\(([\w$]+),([\w$]+)=!1\)\{const ([\w$]+)=([\w$]+)\(([\w$]+)===([\w$]+)\.Offline\)/;
    expect(
      "function Q7(a,b=!1){const c=Zx(a===Ka.Offline),d=Q1(a)",
    ).toMatch(pattern);
  });
});

describe("patchTrayIcon", () => {
  it("returns an error when the asar is missing", async () => {
    const result = await patchTrayIcon({ asarPath: "/nonexistent/app.asar" });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("not found");
  });

  it("injects the Linux icon branch and is idempotent", async () => {
    const { asarPath, cleanup } = await makeTrayAsar(TRAY_BUNDLE_1_3_0);
    try {
      const first = await patchTrayIcon({ asarPath });
      expect(first.success).toBe(true);
      expect(first.patched).toBe(true);
      expect(first.patchCount).toBe(1);

      /* eslint-disable @typescript-eslint/no-var-requires */
      const asar = require("@electron/asar");
      /* eslint-enable @typescript-eslint/no-var-requires */
      const patched = asar
        .extractFile(asarPath, ".vite/build/initLifecycle-abc123.js")
        .toString("utf-8");

      expect(patched).toContain(TRAY_ICON_PATCH_MARKER);
      expect(patched).toContain('process.platform==="linux"');
      expect(patched).toContain('process.resourcesPath,"factory-tray.png"');
      expect(patched).toContain('require("electron").nativeImage.createFromPath');

      const second = await patchTrayIcon({ asarPath });
      expect(second.success).toBe(true);
      expect(second.patched).toBe(false);

      const validation = validateTrayIcon({ asarPath });
      expect(validation.trayIconPatched).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("tolerates a bundle without the tray glyph factory", async () => {
    const { asarPath, cleanup } = await makeTrayAsar(
      "function unrelated(){return 1}",
    );
    try {
      const result = await patchTrayIcon({
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
