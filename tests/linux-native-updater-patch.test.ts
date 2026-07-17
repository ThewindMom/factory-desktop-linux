import { patchLinuxNativeUpdaterContent } from "../src/linux-native-updater-patch";

const FACTORY_UPDATER_SAMPLE =
  'async function iit(){}function lit(e){const{releaseChannel:n}=e;if(h1=n==="production"?"":`${n}/`,process.platform!=="darwin"&&process.platform!=="win32")return he("unsupported",{platform:process.platform}),zt("unsupported",{platform:process.platform}),!1;try{return!0}catch(e){return!1}}q.ipcMain.handle("updates:getState",async()=>BX()),q.ipcMain.handle("updates:install",async()=>{await iit()}),q.ipcMain.handle("updates:checkNow",async()=>{try{await ait()}catch(e){}})';

const FACTORY_0_127_UPDATER_SAMPLE =
  'async function Rct(){}function Pct(e){const{releaseChannel:n}=e;if(P1=n==="production"?"":`${n}/`,process.platform!=="darwin"&&process.platform!=="win32")return he("[auto-updater] Skipping updater on unsupported platform",{platform:process.platform}),It("start-skipped-unsupported-platform",{platform:process.platform}),!1;try{return!0}catch(e){return!1}}q.ipcMain.handle("updates:getState",async()=>YZ()),q.ipcMain.handle("updates:install",async()=>{await Rct()}),q.ipcMain.handle("updates:checkNow",async()=>{try{await Oct()}catch(n){B("[updates:checkNow] Poll failed",{cause:n})}})';

describe("Linux native updater bridge", () => {
  it("reuses Factory's updater state and install IPC contracts on Linux", () => {
    const patched = patchLinuxNativeUpdaterContent(FACTORY_UPDATER_SAMPLE);

    expect(patched).not.toBeNull();
    expect(patched).toContain("linux-native-updater-bridge");
    expect(patched).toContain('process.platform==="linux")return __factoryLinuxUpdates.start()');
    expect(patched).toContain('process.platform==="linux"?__factoryLinuxUpdates.getState()');
    expect(patched).toContain('process.platform==="linux"?await __factoryLinuxUpdates.install()');
    expect(patched).toContain('["check-now"]');
    expect(patched).toContain('["install-ready"]');
    expect(patched).toContain("q.app.exit(0)");
    expect(patched).toContain("FACTORY_UPDATE_MANAGER_PATH");
    expect(patched).toContain('const n=/^\\d+\\.\\d+\\.\\d+$/');
    expect(patched).toContain('r.once("spawn"');
  });

  it("patches the updater contracts shipped by Factory 0.127", () => {
    const patched = patchLinuxNativeUpdaterContent(
      FACTORY_0_127_UPDATER_SAMPLE,
    );

    expect(patched).not.toBeNull();
    expect(patched).toContain("linux-native-updater-bridge");
    expect(patched).toContain("async function Rct()");
    expect(patched).toContain(
      'process.platform==="linux")return __factoryLinuxUpdates.start()',
    );
  });

  it("honors forced repatching by failing closed on an existing marker", () => {
    const patched = patchLinuxNativeUpdaterContent(FACTORY_UPDATER_SAMPLE);

    expect(patched).not.toBeNull();
    expect(patchLinuxNativeUpdaterContent(patched ?? "", false)).toBeNull();
  });

  it("fails closed when Factory renames the bridge insertion anchor", () => {
    const renamedAnchor = FACTORY_UPDATER_SAMPLE.replace(
      "async function iit()",
      "async function zz()",
    );

    expect(patchLinuxNativeUpdaterContent(renamedAnchor)).toBeNull();
  });

  it("fails closed when Factory changes either native updater contract", () => {
    const withoutInstallContract = FACTORY_UPDATER_SAMPLE.replace("updates:install", "updates:apply");

    expect(patchLinuxNativeUpdaterContent(withoutInstallContract)).toBeNull();
  });
});
