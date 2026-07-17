import * as fs from "fs";
import * as asar from "@electron/asar";
import {
  applyAsarContentPatch,
  computeFileHash,
  findMainBundleFiles,
} from "./patches/asar-patcher";

const PATCH_MARKER = "/* linux-native-updater-bridge */";

const STARTUP_PATTERN =
  /if\((\w+=\w+==="production"\?"":`\$\{\w+\}\/`),process\.platform!=="darwin"&&process\.platform!=="win32"\)(return[\s\S]{0,600}?platform:process\.platform\}\),!1);try/;

const GET_STATE_PATTERN = new RegExp(
  '((\\w+)\\.ipcMain\\.handle\\("updates:getState",async\\(\\)=>)(\\w+)\\(\\)\\)',
);

const INSTALL_PATTERN =
  /(\w+\.ipcMain\.handle\("updates:install",async\(\)=>\{)await (\w+)\(\)(\}\))/;

function buildBridgeSource(electron: string): string {
  return `${PATCH_MARKER}const __factoryLinuxUpdates=(()=>{let e={kind:"idle"},t=null;const n=process.env.FACTORY_UPDATE_MANAGER_PATH||"/usr/bin/factory-update-manager",r=(e,t)=>{const n=/^\\d+\\.\\d+\\.\\d+$/;if(!n.test(e)||!n.test(t))return!1;const r=e.split(".").map(Number),o=t.split(".").map(Number);for(let e=0;e<3;e++)if(r[e]!==o[e])return r[e]>o[e];return!1},o=e=>{for(const t of ${electron}.BrowserWindow.getAllWindows())t.isDestroyed()||t.webContents.send("updates:state",e)},s=t=>{e=t,o(t)},i=e=>new Promise((t,r)=>{require("node:child_process").execFile(n,e,{encoding:"utf8",maxBuffer:1048576},(e,n,o)=>{e?r(new Error((o||n||e.message).trim())):t(n)})}),a=async()=>JSON.parse(await i(["status","--json"])),l=async()=>{try{const e=${electron}.app.getVersion(),t=await fetch("https://api.factory.ai/api/desktop/latest-version",{cache:"no-store"}),n=await t.json(),o=n.latestVersion;typeof o==="string"&&r(o,e)?s({kind:"available",currentVersion:e,latestVersion:o,versionsBehind:1}):s({kind:"idle"})}catch(e){s({kind:"error",message:e instanceof Error?e.message:String(e)})}},c=async()=>{const t=e.kind==="available"?e.latestVersion:void 0;try{s({kind:"checking",targetVersion:t});let e=await a();["ready_to_install","waiting_for_app_exit"].includes(e.status)||(s({kind:"downloading",targetVersion:t}),await i(["check-now"]),e=await a());if(!["ready_to_install","waiting_for_app_exit"].includes(e.status))throw new Error(e.error_message||"The Linux update could not be prepared.");s({kind:"downloading",targetVersion:t??e.candidate_version??void 0});await new Promise((e,t)=>{const r=require("node:child_process").spawn(n,["install-ready"],{detached:!0,stdio:"ignore"});r.once("spawn",()=>{r.unref(),e()}),r.once("error",t)}),setTimeout(()=>${electron}.app.exit(0),500)}catch(e){s({kind:"error",message:e instanceof Error?e.message:String(e)})}},u=()=>{if(t)return!0;l(),t=setInterval(l,6e5);const e=()=>{t&&(clearInterval(t),t=null)};return ${electron}.app.on("before-quit",e),!0};return{checkNow:l,getState:()=>e,install:c,start:u}})();`;
}

export interface LinuxNativeUpdaterPatchResult {
  readonly success: boolean;
  readonly patched: boolean;
  readonly originalHash: string;
  readonly patchedHash: string;
  readonly patchCount: number;
  readonly errors: string[];
  readonly warnings: string[];
}

export interface LinuxNativeUpdaterPatchOptions {
  readonly asarPath: string;
  readonly skipIfPatched?: boolean;
  readonly tolerateMissingTarget?: boolean;
}

export function patchLinuxNativeUpdaterContent(
  content: string,
  skipIfPatched = true,
): string | null {
  if (content.includes(PATCH_MARKER)) return skipIfPatched ? content : null;
  if (!content.includes('ipcMain.handle("updates:getState"')) return null;

  const stateMatch = content.match(GET_STATE_PATTERN);
  const electron = stateMatch?.[2];
  const installFunction = content.match(INSTALL_PATTERN)?.[2];
  if (!electron || !installFunction) return null;

  const withBridge = content.replace(
    `async function ${installFunction}(`,
    `${buildBridgeSource(electron)}async function ${installFunction}(`,
  );
  if (withBridge === content) return null;
  const withStartup = withBridge.replace(
    STARTUP_PATTERN,
    'if($1,process.platform==="linux")return __factoryLinuxUpdates.start();if(process.platform!=="darwin"&&process.platform!=="win32")$2;try',
  );
  const withState = withStartup.replace(
    GET_STATE_PATTERN,
    '$1process.platform==="linux"?__factoryLinuxUpdates.getState():$3())',
  );
  const withInstall = withState.replace(
    INSTALL_PATTERN,
    '$1process.platform==="linux"?await __factoryLinuxUpdates.install():await $2()$3',
  );
  const patched = withInstall.replace(
    /(\w+\.ipcMain\.handle\("updates:checkNow",async\(\)=>\{try\{)await (\w+)\(\)/,
    '$1process.platform==="linux"?await __factoryLinuxUpdates.checkNow():await $2()',
  );

  if (
    withStartup === withBridge ||
    withState === withStartup ||
    withInstall === withState ||
    patched === withInstall
  ) return null;
  return patched;
}

export async function patchLinuxNativeUpdater(
  options: LinuxNativeUpdaterPatchOptions,
): Promise<LinuxNativeUpdaterPatchResult> {
  const { asarPath } = options;
  if (!fs.existsSync(asarPath)) {
    return {
      success: false,
      patched: false,
      originalHash: "",
      patchedHash: "",
      patchCount: 0,
      errors: [`app.asar not found: ${asarPath}`],
      warnings: [],
    };
  }

  const originalHash = computeFileHash(asarPath);
  for (const bundleFile of findMainBundleFiles(asarPath)) {
    const content = asar.extractFile(asarPath, bundleFile).toString("utf-8");
    const patched = patchLinuxNativeUpdaterContent(
      content,
      options.skipIfPatched ?? true,
    );
    if (patched === content) {
      return {
        success: true,
        patched: false,
        originalHash,
        patchedHash: originalHash,
        patchCount: 0,
        errors: [],
        warnings: ["Linux native updater bridge is already present."],
      };
    }
    if (patched !== null) {
      await applyAsarContentPatch(asarPath, bundleFile, patched);
      return {
        success: true,
        patched: true,
        originalHash,
        patchedHash: computeFileHash(asarPath),
        patchCount: 5,
        errors: [],
        warnings: [],
      };
    }
  }

  return {
    success: options.tolerateMissingTarget === true,
    patched: false,
    originalHash,
    patchedHash: originalHash,
    patchCount: 0,
    errors: options.tolerateMissingTarget
      ? []
      : ["Factory native updater startup/install contracts were not found."],
    warnings: options.tolerateMissingTarget
      ? ["Factory native updater contracts were not present in the test ASAR."]
      : [],
  };
}
