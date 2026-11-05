/**
 * Linux window icon patch.
 *
 * Problem: Factory Desktop creates its BrowserWindow without an `icon`
 * option. On Linux the taskbar/panel window button therefore falls back to
 * the generic window glyph instead of Factory's logo — the `.desktop` file's
 * `Icon=` key is only used by launchers, not by the window itself, which
 * needs `_NET_WM_ICON` set through the BrowserWindow options.
 *
 * Fix: inject `icon:` into every BrowserWindow options object, pointing at
 * `resources/factory-icon.png` (shipped by packaging next to app.asar, so it
 * works for both the .deb and the AppImage).
 *
 * Version-agnostic design: matched on the constructor call shape
 * `new <alias>.BrowserWindow({`, which is stable across releases.
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

export interface WindowIconPatchOptions {
  asarPath: string;
  skipIfPatched?: boolean;
  tolerateMissingTarget?: boolean;
}

export interface WindowIconNeedle {
  id: string;
  description: string;
  originalSnippet: string;
  replacementSnippet: string;
}

export interface WindowIconPatchResult {
  success: boolean;
  patched: boolean;
  originalHash: string;
  patchedHash: string;
  patchCount: number;
  patches: WindowIconNeedle[];
  errors: string[];
  warnings: string[];
}

export interface ValidateWindowIconOptions {
  asarPath: string;
}

export interface ValidateWindowIconResult {
  valid: boolean;
  windowIconPatched: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Patch Constants ────────────────────────────────────────────────────────

export const WINDOW_ICON_PATCH_MARKER = "/* linux-window-icon-patch */";

/** The icon file packaging copies into `resources/`. */
export const WINDOW_ICON_FILE = "factory-icon.png";

/** Matches `new <alias>.BrowserWindow({`. */
const BROWSER_WINDOW_CTOR_REGEX = /new ([\w$]+)\.BrowserWindow\(\{/g;

// ─── Core Patching ──────────────────────────────────────────────────────────

export async function patchWindowIcon(
  options: WindowIconPatchOptions,
): Promise<WindowIconPatchResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patches: WindowIconNeedle[] = [];
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

    if (!content.includes(".BrowserWindow(")) continue;

    if (skipIfPatched && content.includes(WINDOW_ICON_PATCH_MARKER)) {
      alreadyPatched = true;
      warnings.push(`Bundle ${bundleFile} is already patched. Skipping.`);
      continue;
    }

    const matchCount = (content.match(BROWSER_WINDOW_CTOR_REGEX) || []).length;
    if (matchCount === 0) continue;

    const result: RegexPatchResult = applyRegexPatch(
      content,
      BROWSER_WINDOW_CTOR_REGEX,
      (_match, alias) =>
        `new ${alias}.BrowserWindow({${WINDOW_ICON_PATCH_MARKER}` +
        `icon:require("electron").nativeImage.createFromPath(` +
        `require("node:path").join(process.resourcesPath,"${WINDOW_ICON_FILE}")),`,
    );

    if (!result.matched) continue;

    try {
      await applyAsarContentPatch(options.asarPath, bundleFile, result.content);
    } catch (err) {
      errors.push(
        `Failed to apply window icon patch to ${bundleFile}: ${String(err)}`,
      );
      continue;
    }

    totalPatchCount += matchCount;
    patches.push({
      id: "linux-window-icon",
      description:
        `Set BrowserWindow icon from resources/${WINDOW_ICON_FILE} so the ` +
        `panel/taskbar shows Factory's logo instead of the generic glyph.`,
      originalSnippet: result.match,
      replacementSnippet: `new X.BrowserWindow({${WINDOW_ICON_PATCH_MARKER}icon:...factory-icon.png...,`,
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
    const message = "No BrowserWindow constructor call was found.";
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

export function validateWindowIcon(
  options: ValidateWindowIconOptions,
): ValidateWindowIconResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(options.asarPath)) {
    return {
      valid: false,
      windowIconPatched: false,
      errors: [`app.asar not found: ${options.asarPath}`],
      warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  let windowIconPatched = false;

  for (const bundleFile of findMainBundleFiles(options.asarPath)) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");
    if (content.includes(WINDOW_ICON_PATCH_MARKER)) {
      windowIconPatched = true;
      break;
    }
  }

  if (!windowIconPatched) {
    warnings.push("Window icon patch marker not found in any bundle.");
  }

  return { valid: true, windowIconPatched, errors, warnings };
}
