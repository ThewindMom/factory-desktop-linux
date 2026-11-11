/**
 * Tests for the Linux daemon transport compatibility patch.
 *
 * Validates VAL-DAEMON-001 and VAL-DAEMON-002: The packaged Linux app
 * must not emit `--listen ipc` for the Linux droid daemon, and the
 * daemon must reach a healthy runtime state.
 *
 * Version-agnostic: tests verify the regex patterns match against both
 * Factory 0.106.0 and 0.110.0 minified forms.
 */

import {
  patchDaemonTransport,
  validateDaemonTransport,
  formatDaemonTransportPatchResult,
  formatDaemonTransportValidationResult,
} from "../src/daemon-transport-patch";

import * as fs from "fs";

// ─── Minified code samples from real Factory Desktop asars ────────────────

/**
 * Factory Desktop 0.106.0 transport resolver (minified).
 * Function name: s9t, enum: nc, flag enum: Un, getter: qce, logger: X
 */
const TRANSPORT_0_106_0 =
  'async function s9t(){const e=Un.DesktopDaemonIpc;try{return(await qce())[e.statsigName]??e.defaultValue?nc.Ipc:nc.WebSocket}catch(t){return X("[daemon] Failed to resolve desktop daemon IPC feature flag",{cause:t}),e.defaultValue?nc.Ipc:nc.WebSocket}}';

/**
 * Factory Desktop 0.110.0 transport resolver (minified).
 * Function name: $$e, enum: Ms, flag enum: Zt, getter: dF, logger: G
 */
const TRANSPORT_0_110_0 =
  'async function $$e(){const e=Zt.DesktopDaemonIpc;try{return(await dF())[e.statsigName]??e.defaultValue?Ms.Ipc:Ms.WebSocket}catch(t){return G("[daemon] Failed to resolve desktop daemon IPC feature flag",{cause:t}),e.defaultValue?Ms.Ipc:Ms.WebSocket}}';

/**
 * Factory Desktop 0.116.1 transport resolver (minified).
 * Enum includes "$", which older regexes missed.
 */
const TRANSPORT_0_116_1 =
  'async function mMe(){const e=an.DesktopDaemonIpc;try{return(await CF())[e.statsigName]??e.defaultValue?$s.Ipc:$s.WebSocket}catch(t){return H("[daemon] Failed to resolve desktop daemon IPC feature flag",{cause:t}),e.defaultValue?$s.Ipc:$s.WebSocket}}';

/**
 * Factory Desktop 0.106.0 --listen ipc push (minified).
 * Enum: nc
 */
const LISTEN_IPC_0_106_0 = 'if(t===nc.Ipc&&a.push("--listen","ipc")';

/**
 * Factory Desktop 0.110.0 --listen ipc push (minified).
 * Enum: Ms
 */
const LISTEN_IPC_0_110_0 = 'if(t===Ms.Ipc&&a.push("--listen","ipc")';

// ─── Version-agnostic regex matching ──────────────────────────────────────

describe("daemon-transport-patch version-agnostic matching", () => {
  describe("transport resolver pattern", () => {
    it("matches Factory 0.106.0 minified form", () => {
      const pattern =
        /(async function [\w$]+\(\)\{)(const [\w$]+=[\w$]+\.DesktopDaemonIpc;[\s\S]*?\?[\w$]+\.Ipc:[\w$]+\.WebSocket\})/;
      expect(TRANSPORT_0_106_0).toMatch(pattern);
    });

    it("matches Factory 0.110.0 minified form", () => {
      const pattern =
        /(async function [\w$]+\(\)\{)(const [\w$]+=[\w$]+\.DesktopDaemonIpc;[\s\S]*?\?[\w$]+\.Ipc:[\w$]+\.WebSocket\})/;
      expect(TRANSPORT_0_110_0).toMatch(pattern);
    });

    it("matches Factory 0.116.1 minified form with dollar enum alias", () => {
      const pattern =
        /(async function [\w$]+\(\)\{)(const [\w$]+=[\w$]+\.DesktopDaemonIpc;[\s\S]*?\?[\w$]+\.Ipc:[\w$]+\.WebSocket\})/;
      expect(TRANSPORT_0_116_1).toMatch(pattern);
    });

    it("extracts WebSocket enum reference from 0.106.0", () => {
      const pattern = /([\w$]+\.WebSocket)/;
      const match = TRANSPORT_0_106_0.match(pattern);
      expect(match?.[1]).toBe("nc.WebSocket");
    });

    it("extracts WebSocket enum reference from 0.110.0", () => {
      const pattern = /([\w$]+\.WebSocket)/;
      const match = TRANSPORT_0_110_0.match(pattern);
      expect(match?.[1]).toBe("Ms.WebSocket");
    });

    it("extracts WebSocket enum reference from 0.116.1", () => {
      const pattern = /([\w$]+\.WebSocket)/;
      const match = TRANSPORT_0_116_1.match(pattern);
      expect(match?.[1]).toBe("$s.WebSocket");
    });
  });

  describe("--listen ipc push pattern", () => {
    it("matches Factory 0.106.0 form", () => {
      const pattern = /([\w$]+\.Ipc)&&([\w$]+\.push\("--listen","ipc"\))/;
      expect(LISTEN_IPC_0_106_0).toMatch(pattern);
    });

    it("matches Factory 0.110.0 form", () => {
      const pattern = /([\w$]+\.Ipc)&&([\w$]+\.push\("--listen","ipc"\))/;
      expect(LISTEN_IPC_0_110_0).toMatch(pattern);
    });
  });
});

// ─── patchDaemonTransport ───────────────────────────────────────────────────

describe("patchDaemonTransport", () => {
  it("returns error when asar not found", async () => {
    const result = await patchDaemonTransport({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.success).toBe(false);
    expect(result.patched).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });

  it("patches packaged Linux to resolve the system droid CLI", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */
    const fsSync = fs;
    const tmpDir = path.join(
      process.cwd(),
      "tests",
      ".tmp-daemon-system-droid-" + Date.now(),
    );
    const buildDir = path.join(tmpDir, ".vite", "build");
    fsSync.mkdirSync(buildDir, { recursive: true });
    const bundleContent =
      TRANSPORT_0_106_0 +
      'function hKe({port:e,transportMode:t}){let r,o,s=[];if(q.app.isPackaged)r=Ne.join(process.resourcesPath,"bin",process.platform==="win32"?"droid.exe":"droid");const i=r;const a=[...s,"daemon","--enable-child-ipc","--droid-path",i];if(t===nc.Ipc&&a.push("--listen","ipc"))return a}' +
      'class NKe{constructor(){this.state=xn.Stopped,this.currentPort=null,this.transportMode=null,this.ipcDaemonReady=false,this.processGeneration=0}selectPort(){return Fp()}async resolveTransportMode(){return nc.WebSocket}startHealthPoll(){}async startInternal(){this.state=xn.Starting,this.ipcDaemonReady=!1;const t=await this.resolveTransportMode(),n=t===nc.Ipc,r=n?null:this.currentPort??this.selectPort();this.currentPort=r;const{command:o,args:s,cwd:i,env:a}=hKe({port:r,transportMode:t});me("[daemon] Starting daemon",{command:o,args:s,cwd:i,port:r??void 0,state:t});this.processGeneration++,ze.endPhase(),n?this.startIpcReadyTimeout():this.startHealthPoll()}}';
    fsSync.writeFileSync(path.join(buildDir, "index-SystemDroid.js"), bundleContent);
    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    try {
      const patchResult = await patchDaemonTransport({ asarPath });
      expect(patchResult.success).toBe(true);
      expect(patchResult.patched).toBe(true);
      expect(patchResult.patches.map((p) => p.id)).toContain("use-system-droid-cli");
      expect(patchResult.patches.map((p) => p.id)).toContain("adopt-system-droid-daemon");

      const validation = validateDaemonTransport({ asarPath });
      expect(validation.valid).toBe(true);
      expect(validation.hasSystemDroidPathPatch).toBe(true);
      expect(validation.hasSystemDaemonAdoptionPatch).toBe(true);
      const patchedContent = asar
        .extractFile(asarPath, ".vite/build/index-SystemDroid.js")
        .toString("utf-8");
      expect(patchedContent).toContain("/* linux-system-droid-cli-patch */");
      expect(patchedContent).toContain("FACTORY_DROID_PATH");
      expect(patchedContent).toContain('process.platform==="linux"');
      expect(patchedContent).toContain('"command -v droid"');
      expect(patchedContent).toContain("https://app.factory.ai/cli");
      expect(patchedContent).toContain('"--proto","=https","--tlsv1.2"');
      expect(patchedContent).toContain("mkdtempSync");
      expect(patchedContent).toContain("f.constants.X_OK");
      expect(patchedContent).not.toContain("| sh");
      expect(patchedContent).toContain('p.join(os.homedir(),".local","bin","droid")');
      expect(patchedContent).toContain("/* linux-system-droid-daemon-adoption-patch */");
      expect(patchedContent).toContain("Adopted system Droid daemon");
      expect(patchedContent).toContain('"--user","restart","factory-droid-daemon.service"');
      expect(patchedContent).toContain("attempt<20");
      expect(patchedContent).toContain("setTimeout(resolve,250)");
      expect(patchedContent).toContain("const servicePort=37643");
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patches Factory 0.185.0 hard-coded transport + ternary droid path", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */
    const fsSync = fs;
    const tmpDir = path.join(
      process.cwd(),
      "tests",
      ".tmp-daemon-0185-" + Date.now(),
    );
    const buildDir = path.join(tmpDir, ".vite", "build");
    fsSync.mkdirSync(buildDir, { recursive: true });
    // Shapes extracted from the real Factory 0.185.0 main bundle
    // (.vite/build/index-DbSjjjvD.js), minified names preserved.
    const bundleContent =
      "function Wct(){return Zc.Ipc}const Vct=20;" +
      'function elt({port:e,transportMode:t}){const n=W.app.isPackaged?Ie.join(process.resourcesPath,"bin",process.platform==="win32"?"droid.exe":"droid"):void 0,{command:r,prefixArgs:o,droidPathForSessions:s,extraEnv:i}=n?{command:n,prefixArgs:[],droidPathForSessions:n}:Qct(Jct()),c=[...o,"daemon",...s?["--droid-path",s]:[]];if(t===Zc.Ipc&&c.push("--listen","ipc"),W.app.isPackaged||c.push("--debug"),t===Zc.WebSocket){if(e===null)throw new me("WebSocket daemon transport requires a port");c.push("--host",Tm),c.push("--port",String(e))}return{command:r,args:c,cwd:Jr(),env:{...i??{},FACTORY_HOME_OVERRIDE:Jr()}}}' +
      'class DKe{constructor(){this.state=rr.Stopped,this.currentPort=null,this.transportMode=null,this.processGeneration=0}async startInternal(){this.state=rr.Starting,this.ipcDaemonReady=!1;const t=await this.resolveTransportMode(),n=t===Zc.Ipc,r=n?null:this.currentPort??this.selectPort();this.currentPort=r;const{command:o,args:s,cwd:i,env:c}=elt({port:r,transportMode:t});ve("[daemon] Starting daemon",{command:o,args:s,cwd:i,port:r??void 0,state:t});this.processGeneration++,ze.endPhase(),n?this.startIpcReadyTimeout():this.startHealthPoll()}}';
    fsSync.writeFileSync(path.join(buildDir, "index-0185.js"), bundleContent);
    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    try {
      const patchResult = await patchDaemonTransport({ asarPath });
      expect(patchResult.success).toBe(true);
      expect(patchResult.patched).toBe(true);
      const ids = patchResult.patches.map((p) => p.id);
      expect(ids).toContain("force-websocket-on-linux-0185");
      expect(ids).toContain("prevent-listen-ipc-on-linux");
      expect(ids).toContain("use-system-droid-cli-0185");
      expect(ids).toContain("adopt-system-droid-daemon");

      const validation = validateDaemonTransport({ asarPath });
      expect(validation.valid).toBe(true);
      expect(validation.forcesWebSocketOnLinux).toBe(true);
      expect(validation.hasSystemDroidPathPatch).toBe(true);
      expect(validation.hasSystemDaemonAdoptionPatch).toBe(true);

      const patched = asar
        .extractFile(asarPath, ".vite/build/index-0185.js")
        .toString("utf-8");
      expect(patched).toContain(
        'return process.platform==="linux"?Zc.WebSocket:Zc.Ipc}',
      );
      expect(patched).toContain('Zc.Ipc&&process.platform!=="linux"&&');
      // The Linux droid resolver must return the same object shape as the
      // upstream packaged arm ({command,prefixArgs,droidPathForSessions}); a
      // bare string caused "o is not iterable" at daemon spawn time.
      expect(patched).toContain(
        "return{command:d,prefixArgs:[],droidPathForSessions:d}",
      );

      // Behavioral check: evaluate the patched elt() in isolation and ensure
      // it builds valid daemon args on Linux (WebSocket path, no --listen ipc).
      const eltStart = patched.indexOf("function elt(");
      expect(eltStart).toBeGreaterThan(0);
      // Skip the destructured parameter list, then brace-count the body.
      const paramClose = patched.indexOf(")", eltStart);
      let depth = 0;
      let eltEnd = -1;
      for (let i = patched.indexOf("{", paramClose); i < patched.length; i++) {
        if (patched[i] === "{") depth++;
        else if (patched[i] === "}") {
          depth--;
          if (depth === 0) {
            eltEnd = i + 1;
            break;
          }
        }
      }
      expect(eltEnd).toBeGreaterThan(eltStart);
      const fsMod = fs;
      /* eslint-disable @typescript-eslint/no-var-requires */
      const osMod = require("os") as typeof import("os");
      const modPath = require("path") as typeof import("path");
      /* eslint-enable @typescript-eslint/no-var-requires */
      const eltFile = modPath.join(osMod.tmpdir(), "elt-patched-" + Date.now() + ".js");
      fsMod.writeFileSync(
        eltFile,
        "const Ie={join:(...a)=>a.join('/')};" +
          "const W={app:{isPackaged:true}};" +
          'const Zc={Ipc:"ipc",WebSocket:"websocket"};' +
          'const Tm="127.0.0.1";' +
          "const Jr=()=>'/home/tester';" +
          "const Qct=()=>({command:'bun',prefixArgs:['x'],droidPathForSessions:'bun'});" +
          "const Jct=()=>({});" +
          'class me extends Error{};' +
          patched.slice(eltStart, eltEnd) +
          ";module.exports={elt};",
      );
      // A real executable fixture: the resolver verifies X_OK before honoring
      // FACTORY_DROID_PATH, so a nonexistent path would be (correctly) skipped.
      const droidFixture = eltFile + ".droid";
      fsMod.writeFileSync(droidFixture, "#!/bin/sh\n");
      fsMod.chmodSync(droidFixture, 0o755);
      try {
        // Pin the droid resolution so the test never hits the network branch.
        process.env.FACTORY_DROID_PATH = droidFixture;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { elt } = require(eltFile);
        const ws = elt({ port: 41248, transportMode: "websocket" });
        expect(ws.command).toBe(droidFixture);
        expect(ws.args).toContain("daemon");
        expect(ws.args).toContain("--host");
        expect(ws.args).toContain("--port");
        expect(ws.args).not.toContain("--listen");
        // Empty prefixArgs from the Linux resolver arm means "daemon" leads args.
        expect(ws.args[0]).toBe("daemon");
        const ipc = elt({ port: null, transportMode: "ipc" });
        expect(ipc.args).not.toContain("--listen");
      } finally {
        delete process.env.FACTORY_DROID_PATH;
        fsMod.rmSync(eltFile, { force: true });
        fsMod.rmSync(eltFile + ".droid", { force: true });
      }
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patches Factory 0.208.0 initLifecycle chunk (dotted enum alias)", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */
    const fsSync = fs;
    const tmpDir = path.join(
      process.cwd(),
      "tests",
      ".tmp-daemon-0208-" + Date.now(),
    );
    const buildDir = path.join(tmpDir, ".vite", "build");
    fsSync.mkdirSync(buildDir, { recursive: true });
    // Shapes extracted from the real Factory 0.208.0 build shipped in
    // the deb (chunk .vite/build/initLifecycle-D3kvsJfz.js), minified
    // names preserved. From 0.208.0 the daemon spawn code moved out of
    // index-*.js into initLifecycle-*.js and the transport enum became a
    // module-alias chain (s.DesktopDaemonTransportMode.Ipc).
    const bundleContent =
      'const xt=new hB;function mB(){return s.DesktopDaemonTransportMode.Ipc}const Ro=new Set;' +
      'function SB({port:e,transportMode:t}){const n=k.app.isPackaged?Q.join(process.resourcesPath,"bin",process.platform==="win32"?"droid.exe":"droid"):void 0,{command:o,prefixArgs:r,droidPathForSessions:i,extraEnv:a}=n?{command:n,prefixArgs:[],droidPathForSessions:n}:_B(bB()),c=[...r,"daemon",...i?["--droid-path",i]:[]];if(t===s.DesktopDaemonTransportMode.Ipc&&c.push("--listen","ipc"),k.app.isPackaged||c.push("--debug"),t===s.DesktopDaemonTransportMode.WebSocket){if(e===null)throw new s.MetaError("WebSocket daemon transport requires a port");c.push("--host",ra),c.push("--port",String(e)),process.platform==="win32"?c.push("--parent-pid",String(process.pid)):c.push("--liveness-fd","3")}const l=s.getDesktopHomeDir();return{command:o,args:c,cwd:l,env:{...a??{},FACTORY_HOME_OVERRIDE:l}}}' +
      'class x9e{constructor(){this.state=He.Stopped,this.currentPort=null,this.transportMode=null,this.ipcDaemonReady=false,this.processGeneration=0}selectPort(){return Fp()}async resolveTransportMode(){return mB()}startHealthPoll(){}async startInternal(){this.state=He.Starting,this.ipcDaemonReady=!1;const t=await this.resolveTransportMode(),n=t===s.DesktopDaemonTransportMode.Ipc,o=n?null:this.currentPort??this.selectPort();this.currentPort=o;const{command:r,args:i,cwd:a,env:c}=SB({port:o,transportMode:t});s.logInfo("[daemon] Starting daemon",{command:r,args:i,cwd:a,port:o??void 0,state:t});this.processGeneration++,s.startupTracker.endPhase(),n?this.startIpcReadyTimeout():this.startHealthPoll()}}';
    fsSync.writeFileSync(
      path.join(buildDir, "initLifecycle-D3kvsJfz.js"),
      bundleContent,
    );
    // An unrelated index chunk must not break the scan of the new chunk.
    fsSync.writeFileSync(path.join(buildDir, "index-DlQW8R5W.js"), '"use strict";require("./initLifecycle-D3kvsJfz.js");');
    fsSync.writeFileSync(path.join(buildDir, "main.js"), '"use strict";require("./index-DlQW8R5W.js");');
    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    try {
      const patchResult = await patchDaemonTransport({ asarPath });
      expect(patchResult.success).toBe(true);
      expect(patchResult.patched).toBe(true);
      const ids = patchResult.patches.map((p) => p.id);
      expect(ids).toContain("force-websocket-on-linux-0185");
      expect(ids).toContain("prevent-listen-ipc-on-linux");
      expect(ids).toContain("use-system-droid-cli-0185");
      expect(ids).toContain("adopt-system-droid-daemon");

      const validation = validateDaemonTransport({ asarPath });
      expect(validation.valid).toBe(true);
      expect(validation.forcesWebSocketOnLinux).toBe(true);
      expect(validation.hasListenIpcGuard).toBe(true);
      expect(validation.hasSystemDroidPathPatch).toBe(true);
      expect(validation.hasSystemDaemonAdoptionPatch).toBe(true);

      const patched = asar
        .extractFile(asarPath, ".vite/build/initLifecycle-D3kvsJfz.js")
        .toString("utf-8");
      expect(patched).toContain(
        'return process.platform==="linux"?s.DesktopDaemonTransportMode.WebSocket:s.DesktopDaemonTransportMode.Ipc}',
      );
      expect(patched).toContain(
        's.DesktopDaemonTransportMode.Ipc&&process.platform!=="linux"&&c.push("--listen","ipc")',
      );
      expect(patched).toContain(
        "return{command:d,prefixArgs:[],droidPathForSessions:d}",
      );
      expect(patched).toContain("adopted_system_daemon");
      expect(patched).toContain("const servicePort=37643");
      // The bundled arm is no longer consulted: the resolver's Linux branch
      // replaced the destructuring ternary (the dead `const n=...⋾0` prefix
      // remains, as in the 0.185.0 patched form).
      expect(patched).toContain(
        "=n?(()=>{/* linux-system-droid-cli-patch */if(process.platform!==\"linux\")return n;",
      );
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("hard-fails when nothing matches and no patch markers exist (build gate)", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */
    const fsSync = fs;
    const tmpDir = path.join(
      process.cwd(),
      "tests",
      ".tmp-daemon-gate-" + Date.now(),
    );
    const buildDir = path.join(tmpDir, ".vite", "build");
    fsSync.mkdirSync(buildDir, { recursive: true });
    // A bundle with no daemon code at all (like the 0.208.0 chunks that do
    // not own the daemon): nothing matches, no markers.
    fsSync.writeFileSync(
      path.join(buildDir, "index-Unrelated.js"),
      '"use strict";const unrelated=1;module.exports={unrelated};',
    );
    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    try {
      const result = await patchDaemonTransport({ asarPath });
      expect(result.success).toBe(false);
      expect(result.patched).toBe(false);
      expect(result.errors.join(" ")).toContain("matched nothing in the asar");
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("tolerateMissingTarget hard-fails when no bundles exist and markers are absent", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */
    const fsSync = fs;
    const tmpDir = path.join(
      process.cwd(),
      "tests",
      ".tmp-daemon-nobundles-" + Date.now(),
    );
    // No .vite/build directory at all → findMainBundleFiles returns [] and
    // the raw-marker scan finds nothing.
    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    try {
      const result = await patchDaemonTransport({
        asarPath,
        tolerateMissingTarget: true,
      });
      expect(result.success).toBe(false);
      expect(result.errors.join(" ")).toContain("matched nothing and no patch markers");
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("tolerateMissingTarget still succeeds when markers are already present", async () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const asar = require("@electron/asar");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-var-requires */
    const fsSync = fs;
    const tmpDir = path.join(
      process.cwd(),
      "tests",
      ".tmp-daemon-already-" + Date.now(),
    );
    // No .vite/build bundles, but the archive already carries the marker
    // (e.g. the whole main bundle lives elsewhere and was patched before).
    fsSync.mkdirSync(tmpDir, { recursive: true });
    fsSync.writeFileSync(
      path.join(tmpDir, "somewhere-else.js"),
      '/* linux-system-droid-cli-patch */const patchedBefore=1;',
    );
    const asarPath = path.join(tmpDir, "app.asar");
    await asar.createPackage(tmpDir, asarPath);

    try {
      const result = await patchDaemonTransport({
        asarPath,
        tolerateMissingTarget: true,
      });
      expect(result.success).toBe(true);
      expect(result.patched).toBe(false);
    } finally {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Integration test with actual built asar. Opt-in only: the local build dir
  // may be stale and should not make the normal Jest suite environment-dependent.
  const builtAsarPath =
    "/home/thewind/Projects/00_Random_Coding/factory-droid-desktop-linux-port/build/factory-desktop-linux-unpacked/resources/app.asar";
  const systemDroidPath = "/home/thewind/.local/bin/droid";
  const hasBuiltAsar =
    process.env.FACTORY_TEST_BUILT_ASAR === "1" &&
    fs.existsSync(builtAsarPath) &&
    (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const asar = require("@electron/asar");
        return asar
          .listPackage(builtAsarPath)
          .some((file: string) =>
            file.endsWith(".js") &&
            asar
              .extractFile(builtAsarPath, file.slice(1))
              .toString("utf-8")
              .includes("/* linux-system-droid-cli-patch */"),
          );
      } catch {
        return false;
      }
    })();

  const describeIfBuilt = hasBuiltAsar ? describe : describe.skip;

  describeIfBuilt("integration with built app.asar", () => {
    it("validates daemon transport in the built asar", () => {
      const result = validateDaemonTransport({
        asarPath: builtAsarPath,
        droidPath: fs.existsSync(systemDroidPath) ? systemDroidPath : undefined,
      });

      // The built asar should be patched (assembly applies the patch)
      expect(result.valid).toBe(true);
      expect(result.forcesWebSocketOnLinux).toBe(true);
      expect(result.hasListenIpcGuard).toBe(true);
      expect(result.hasSystemDroidPathPatch).toBe(true);
      expect(result.hasSystemDaemonAdoptionPatch).toBe(true);
    });

    it("droid daemon supports --listen flag (latest droid)", () => {
      if (!fs.existsSync(systemDroidPath)) return;

      const result = validateDaemonTransport({
        asarPath: builtAsarPath,
        droidPath: systemDroidPath,
      });

      // The latest droid CLI supports --listen with choices websocket/ipc.
      // The transport patch still forces WebSocket as defense-in-depth,
      // but --listen is no longer an unsupported flag.
      expect(result.listenFlagSupported).toBe(true);
      expect(result.supportedDaemonFlags).toBeDefined();
      if (result.supportedDaemonFlags) {
        expect(result.supportedDaemonFlags).toContain("--host");
        expect(result.supportedDaemonFlags).toContain("--port");
        expect(result.supportedDaemonFlags).toContain("--unix");
        expect(result.supportedDaemonFlags).toContain("--listen");
      }
    });
  });
});

// ─── validateDaemonTransport ───────────────────────────────────────────────

describe("validateDaemonTransport", () => {
  it("returns error when asar not found", () => {
    const result = validateDaemonTransport({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.valid).toBe(false);
    expect(result.forcesWebSocketOnLinux).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("not found")]),
    );
  });

  it("handles missing droid path gracefully", () => {
    const result = validateDaemonTransport({
      asarPath: "/nonexistent/app.asar",
    });

    expect(result.listenFlagSupported).toBe(false);
    expect(result.supportedDaemonFlags).toBeUndefined();
  });
});

// ─── Formatting Functions ──────────────────────────────────────────────────

describe("formatDaemonTransportPatchResult", () => {
  it("formats patched result", () => {
    const result = formatDaemonTransportPatchResult({
      success: true,
      patched: true,
      originalHash: "abc123",
      patchedHash: "def456",
      patchCount: 2,
      patches: [
        {
          id: "force-websocket-on-linux",
          description: "Test patch",
          originalSnippet: "original",
          replacementSnippet: "replacement",
        },
      ],
      errors: [],
      warnings: [],
    });

    expect(result).toContain("Daemon transport patch applied");
    expect(result).toContain("2");
  });

  it("formats skipped result", () => {
    const result = formatDaemonTransportPatchResult({
      success: true,
      patched: false,
      originalHash: "abc123",
      patchedHash: "abc123",
      patchCount: 0,
      patches: [],
      errors: [],
      warnings: [],
    });

    expect(result).toContain("No daemon transport patch was needed");
  });

  it("formats error result", () => {
    const result = formatDaemonTransportPatchResult({
      success: false,
      patched: false,
      originalHash: "",
      patchedHash: "",
      patchCount: 0,
      patches: [],
      errors: ["Something went wrong"],
      warnings: [],
    });

    expect(result).toContain("Something went wrong");
  });
});

describe("formatDaemonTransportValidationResult", () => {
  it("formats passing result", () => {
    const result = formatDaemonTransportValidationResult({
      valid: true,
      forcesWebSocketOnLinux: true,
      hasListenIpcGuard: true,
      hasSystemDroidPathPatch: true,
      hasSystemDaemonAdoptionPatch: true,
      listenFlagSupported: false,
      errors: [],
      warnings: [],
    });

    expect(result).toContain("validation passed");
    expect(result).toContain("Yes");
    expect(result).toContain("System droid CLI resolver");
  });

  it("formats failing result", () => {
    const result = formatDaemonTransportValidationResult({
      valid: false,
      forcesWebSocketOnLinux: false,
      hasListenIpcGuard: false,
      listenFlagSupported: false,
      hasSystemDroidPathPatch: false,
      hasSystemDaemonAdoptionPatch: false,
      errors: ["IPC transport can still be selected"],
      warnings: [],
    });

    expect(result).toContain("FAILED");
    expect(result).toContain("No");
  });

  it("includes supported flags when available", () => {
    const result = formatDaemonTransportValidationResult({
      valid: true,
      forcesWebSocketOnLinux: true,
      hasListenIpcGuard: true,
      listenFlagSupported: false,
      hasSystemDroidPathPatch: true,
      hasSystemDaemonAdoptionPatch: true,
      supportedDaemonFlags: ["--host", "--port", "--unix"],
      errors: [],
      warnings: [],
    });

    expect(result).toContain("--host");
    expect(result).toContain("--port");
  });
});
