/**
 * Window controls compatibility patch for Linux builds.
 *
 * Problem: Factory Desktop sets `titleBarStyle: "hidden"` when not on
 * Windows. On macOS, `"hidden"` is fine because the OS draws traffic
 * light buttons. On Linux, `"hidden"` means no title bar at all — no
 * minimize, maximize, or close buttons. The user cannot move, resize,
 * or close the window without keyboard shortcuts.
 *
 * Fix: Override `titleBarStyle` to `"default"` on Linux so the native
 * window manager draws the standard title bar with min/max/close buttons.
 *
 * Version-agnostic design: The regex matches the ternary pattern
 * `titleBarStyle:<var>?"default":"hidden"` regardless of the minified
 * variable name.
 *
 * Fulfills: VAL-WINDOW-001
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

export interface WindowControlsPatchOptions {
  asarPath: string;
  skipIfPatched?: boolean;
  tolerateMissingTarget?: boolean;
}

export interface WindowControlsPatchResult {
  success: boolean;
  patched: boolean;
  originalHash: string;
  patchedHash: string;
  patchCount: number;
  patches: WindowControlsPatch[];
  errors: string[];
  warnings: string[];
}

export interface WindowControlsPatch {
  id: string;
  description: string;
  originalSnippet: string;
  replacementSnippet: string;
}

export interface ValidateWindowControlsOptions {
  asarPath: string;
}

export interface ValidateWindowControlsResult {
  valid: boolean;
  titleBarStyleDefaultOnLinux: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Patch Constants ────────────────────────────────────────────────────────

const PATCH_MARKER = "/* linux-window-controls-patch */";

/**
 * Regex matching the titleBarStyle ternary.
 *
 * The minified pattern is:
 * ```js
 * titleBarStyle:<var>?"default":"hidden"
 * ```
 * where `<var>` is typically `process.platform === "win32"`.
 *
 * We replace it with:
 * ```js
 * titleBarStyle:process.platform==="linux"?"default":(<var>?"default":"hidden")
 * ```
 * so Linux gets the default title bar, while macOS keeps its hidden style
 * with traffic light buttons.
 *
 * The regex captures the variable name so we can preserve it in the
 * replacement.
 */
const TITLE_BAR_STYLE_REGEX =
  /titleBarStyle:(\w+)\?"default":"hidden"/;

/**
 * Build the replacement for the titleBarStyle ternary.
 *
 * On Linux: returns "default" (native title bar with min/max/close).
 * On other platforms: preserves the original ternary.
 */
function buildTitleBarStyleReplacement(varRef: string): string {
  return `titleBarStyle:process.platform==="linux"?"default":(${varRef}?"default":"hidden")`;
}

// ─── Core Patching Functions ────────────────────────────────────────────────

export async function patchWindowControls(
  options: WindowControlsPatchOptions,
): Promise<WindowControlsPatchResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patches: WindowControlsPatch[] = [];
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
      "Could not find the main Vite bundle file (.vite/build/index-*.js) in the asar.";

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

    if (skipIfPatched && content.includes(PATCH_MARKER)) {
      alreadyPatched = true;
      warnings.push(`Bundle ${bundleFile} is already patched. Skipping.`);
      continue;
    }

    if (!content.includes("titleBarStyle")) continue;

    let patchedContent = content;

    const result: RegexPatchResult = applyRegexPatch(
      patchedContent,
      TITLE_BAR_STYLE_REGEX,
      (_match, varRef) =>
        PATCH_MARKER + buildTitleBarStyleReplacement(varRef),
    );

    if (result.matched) {
      patchedContent = result.content;

      try {
        await applyAsarContentPatch(
          options.asarPath,
          bundleFile,
          patchedContent,
        );
      } catch (err) {
        errors.push(
          `Failed to apply patch to ${bundleFile} in asar: ${String(err)}`,
        );
        continue;
      }

      totalPatchCount++;
      patches.push({
        id: "force-default-titlebar-on-linux",
        description:
          'Override titleBarStyle to "default" on Linux so the native ' +
            "window manager draws min/max/close buttons",
        originalSnippet: result.match,
        replacementSnippet: "...force default titlebar on Linux...",
      });
    }
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
    warnings.push(
      "No window controls patches were applied. The asar may already be " +
        "patched, or no titleBarStyle references were found.",
    );
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

// ─── Validation Functions ───────────────────────────────────────────────────

export function validateWindowControls(
  options: ValidateWindowControlsOptions,
): ValidateWindowControlsResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(options.asarPath)) {
    return {
      valid: false,
      titleBarStyleDefaultOnLinux: false,
      errors: [`app.asar not found: ${options.asarPath}`],
      warnings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  const mainBundleFiles = findMainBundleFiles(options.asarPath);

  let titleBarStyleDefaultOnLinux = false;

  for (const bundleFile of mainBundleFiles) {
    const content = asar
      .extractFile(options.asarPath, bundleFile)
      .toString("utf-8");

    if (!content.includes("titleBarStyle")) continue;

    const match = content.match(TITLE_BAR_STYLE_REGEX);
    if (match) {
      // Check if the matched ternary already has a Linux guard
      const pos = content.indexOf(match[0]);
      const before = content.substring(Math.max(0, pos - 80), pos);
      if (
        before.includes('process.platform==="linux"') ||
        before.includes(PATCH_MARKER)
      ) {
        titleBarStyleDefaultOnLinux = true;
      } else {
        errors.push(
          'titleBarStyle is set to "hidden" on Linux. The window will have ' +
            "no title bar or min/max/close buttons.",
        );
      }
    } else if (content.includes(PATCH_MARKER)) {
      titleBarStyleDefaultOnLinux = true;
    }
  }

  const valid = errors.length === 0;

  return {
    valid,
    titleBarStyleDefaultOnLinux,
    errors,
    warnings,
  };
}

// ─── Formatting Functions ───────────────────────────────────────────────────

export function formatWindowControlsPatchResult(
  result: WindowControlsPatchResult,
): string {
  const lines: string[] = [];

  if (result.patched) {
    lines.push("✓ Window controls patch applied successfully.");
    lines.push(`  Patches applied: ${result.patchCount}`);
    for (const patch of result.patches) {
      lines.push(`  - [${patch.id}] ${patch.description}`);
    }
    lines.push(
      `  Original asar hash: ${result.originalHash.substring(0, 16)}...`,
    );
    lines.push(
      `  Patched asar hash:  ${result.patchedHash.substring(0, 16)}...`,
    );
  } else if (result.success) {
    lines.push(
      "ℹ No window controls patch was needed (already patched or no titleBarStyle references).",
    );
  }

  for (const err of result.errors) {
    lines.push(`✗ ${err}`);
  }
  for (const warn of result.warnings) {
    lines.push(`⚠ ${warn}`);
  }

  return lines.join("\n");
}

export function formatWindowControlsValidationResult(
  result: ValidateWindowControlsResult,
): string {
  const lines: string[] = [];

  lines.push(
    result.valid
      ? "✓ Window controls validation passed."
      : "✗ Window controls validation FAILED.",
  );

  lines.push(
    `  titleBarStyle "default" on Linux: ${result.titleBarStyleDefaultOnLinux ? "✓ Yes" : "✗ No"}`,
  );

  for (const err of result.errors) {
    lines.push(`  ✗ ${err}`);
  }
  for (const warn of result.warnings) {
    lines.push(`  ⚠ ${warn}`);
  }

  return lines.join("\n");
}
