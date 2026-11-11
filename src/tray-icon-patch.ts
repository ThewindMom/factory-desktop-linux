/**
 * Linux tray icon patch.
 *
 * Problem: Factory Desktop builds its menu-bar/tray image with a generated
 * glyph (`Mh(state)`), drawing a monochrome vector mark and, on macOS only,
 * marking it as a template image so the OS recolors it for the menu bar.
 * On Linux the template flag is skipped and the glyph is drawn as-is, so the
 * tray shows a small monochrome symbol instead of Factory's actual logo.
 *
 * Fix: make the glyph factory return the packaged Factory icon on Linux.
 * `process.resourcesPath` is /opt/Factory/resources in the .deb and the
 * AppImage's resources directory, where packaging ships `factory-tray.png`
 * (32 px) and `factory-tray@2x.png` (64 px); Electron loads the @2x variant
 * automatically for HiDPI panels.
 *
 * Version-agnostic design: the generated glyph factory is matched
 * structurally — a two-argument function whose body starts by mapping a
 * state value through `===<alias>.Offline` — rather than by its minified
 * name, which changes every release.
 */

import * as fs from "fs";
import {
  applyAsarContentPatch,
  applyRegexPatch,
  computeFileHash,
  findMainBundleFiles,
  type RegexPatchResult,
} from "./patches/asar-patcher";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TrayIconPatchOptions {
  asarPath: string;
  skipIfPatched?: boolean;
  tolerateMissingTarget?: boolean;
}

export interface TrayIconNeedle {
  id: string;
  description: string;
  originalSnippet: string;
  replacementSnippet: string;
}

export interface TrayIconPatchResult {
  success: boolean;
  patched: boolean;
  originalHash: string;
  patchedHash: string;
  patchCount: number;
  patches: TrayIconNeedle[];
  errors: string[];
  warnings: string[];
}

export interface ValidateTrayIconOptions {
  asarPath: string;
}

export interface ValidateTrayIconResult {
  valid: boolean;
  trayIconPatched: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Patch Constants ────────────────────────────────────────────────────────

export const TRAY_ICON_PATCH_MARKER = "/* linux-tray-icon-patch */";

/** The icon file packaging copies into `resources/`. */
export const TRAY_ICON_FILE = "factory-tray.png";

/**
 * Structural match for the tray glyph factory.
 *
 * Minified shape (1.3.0):
 *   function Mh(e,t=!1){const n=P0e(e===Ft.Offline),r=M0e(e),...
 *
 * Captures:
 *   1. function name (`Mh`)
 *   2. state argument (`e`)
 *   3. badge/subscript argument with its default (`t`)
 *   4. glyph variable (`n`)
 *   5. glyph lookup helper (`P0e`)
 *   6. state expression (`e`)
 *   7. state module alias (`Ft`)
 */
const TRAY_GLYPH_FACTORY_REGEX =
  /function ([\w$]+)\(([\w$]+),([\w$]+)=!1\)\{const ([\w$]+)=([\w$]+)\(([\w$]+)===([\w$]+)\.Offline\)/;

// ─── Core Patching ──────────────────────────────────────────────────────────

/**
 * Apply the Linux tray icon patch to an app.asar.
 *
 * The asar is scanned for the generated-glyph factory; only chunks that also
 * construct a `Tray` are considered, so an unrelated function with the same
 * shape cannot be modified.
 */
export async function patchTrayIcon(
  options: TrayIconPatchOptions,
): Promise<TrayIconPatchResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patches: TrayIconNeedle[] = [];
  const skipIfPatched = options.skipIfPatched ?? true;

  if (!fs.existsSync(options.asarPath)) {
    return {
      success: false,
      patched: false,
      originalHash: "",
      patchedHash: "",
      patchCount: 0,
      patches: [],
      errors: [`app.asar not found: ${options.asarPath}`],
      warnings,
    };
  }

  const originalHash = computeFileHash(options.asarPath);
  const mainBundleFiles = findMainBundleFiles(options.asarPath);

  if (mainBundleFiles.length === 0) {
    const message =
      "Could not find any main-process bundle (.vite/build/*.js) in the asar.";
    if (options.tolerateMissingTarget) {
      warnings.push(message + " Skipping patch (tolerateMissingTarget=true).");
      return {
        success: true,
        patched: false,
        originalHash,
        patchedHash: originalHash,
        patchCount: 0,
        patches: [],
        errors: [],
        warnings,
      };
    }
    return {
      success: false,
      patched: false,
      originalHash,
      patchedHash: originalHash,
      patchCount: 0,
      patches: [],
      errors: [message],
      warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  let totalPatchCount = 0;
  let alreadyPatched = false;

  for (const bundleFile of mainBundleFiles) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");

    // The tray lives in the chunk that also constructs a Tray instance.
    if (!content.includes(".Tray(")) continue;

    if (skipIfPatched && content.includes(TRAY_ICON_PATCH_MARKER)) {
      alreadyPatched = true;
      warnings.push(`Bundle ${bundleFile} is already patched. Skipping.`);
      continue;
    }

    const match = content.match(TRAY_GLYPH_FACTORY_REGEX);
    if (!match || match.index === undefined) continue;

    const [fnName, stateArg, badgeArg, glyphVar, glyphFn, stateExpr, stateMod] =
      match.slice(1);

    const linuxBranch =
      `if(process.platform==="linux"){` +
      `try{` +
      `const p=require("node:path").join(process.resourcesPath,"${TRAY_ICON_FILE}"),` +
      `g=require("electron").nativeImage.createFromPath(p);` +
      `if(!g.isEmpty())return g` +
      `}catch{}` +
      `}` +
      TRAY_ICON_PATCH_MARKER;

    const result: RegexPatchResult = applyRegexPatch(
      content,
      TRAY_GLYPH_FACTORY_REGEX,
      () =>
        `function ${fnName}(${stateArg},${badgeArg}=!1){${linuxBranch}` +
        `const ${glyphVar}=${glyphFn}(${stateExpr}===${stateMod}.Offline)`,
    );

    if (!result.matched) continue;

    try {
      await applyAsarContentPatch(options.asarPath, bundleFile, result.content);
    } catch (err) {
      errors.push(
        `Failed to apply tray icon patch to ${bundleFile}: ${String(err)}`,
      );
      continue;
    }

    totalPatchCount++;
    patches.push({
      id: "linux-tray-icon",
      description:
        "Return Factory's packaged icon from the tray glyph factory on Linux " +
        "instead of the generated monochrome template glyph.",
      originalSnippet: result.match,
      replacementSnippet:
        `function ${fnName}(...){${linuxBranch}const ${glyphVar}=${glyphFn}(...)}`,
    });
  }

  const patchedHash = computeFileHash(options.asarPath);

  if (alreadyPatched && totalPatchCount === 0) {
    return {
      success: true,
      patched: false,
      originalHash,
      patchedHash: originalHash,
      patchCount: 0,
      patches: [],
      errors: [],
      warnings,
    };
  }

  if (errors.length > 0) {
    return {
      success: false,
      patched: totalPatchCount > 0,
      originalHash,
      patchedHash,
      patchCount: totalPatchCount,
      patches,
      errors,
      warnings,
    };
  }

  if (totalPatchCount === 0) {
    const message =
      "No tray glyph factory was found in the main-process bundles.";
    if (!options.tolerateMissingTarget) {
      return {
        success: false,
        patched: false,
        originalHash,
        patchedHash,
        patchCount: 0,
        patches,
        errors: [message],
        warnings,
      };
    }
    warnings.push(message + " Skipping patch (tolerateMissingTarget=true).");
  }

  return {
    success: true,
    patched: totalPatchCount > 0,
    originalHash,
    patchedHash,
    patchCount: totalPatchCount,
    patches,
    errors,
    warnings,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Check whether the tray icon patch is present in an asar. */
export function validateTrayIcon(
  options: ValidateTrayIconOptions,
): ValidateTrayIconResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(options.asarPath)) {
    return {
      valid: false,
      trayIconPatched: false,
      errors: [`app.asar not found: ${options.asarPath}`],
      warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  let trayIconPatched = false;

  for (const bundleFile of findMainBundleFiles(options.asarPath)) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");
    if (content.includes(TRAY_ICON_PATCH_MARKER)) {
      trayIconPatched = true;
      break;
    }
  }

  if (!trayIconPatched) {
    warnings.push("Tray icon patch marker not found in any bundle.");
  }

  return { valid: true, trayIconPatched, errors, warnings };
}
