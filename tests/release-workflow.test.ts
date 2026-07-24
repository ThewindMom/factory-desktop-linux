import * as fs from "fs";
import * as path from "path";

const repoRoot = path.resolve(__dirname, "..");

describe("release automation contract", () => {
  it("uses the public Linux builder package manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
    ) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(manifest.name).toBe("factory-droid-desktop-linux-port");
    expect(manifest).toMatchObject({
      author: {
        email: expect.stringContaining("@"),
      },
    });
    expect(manifest.scripts?.test).toBe("jest");
    expect(manifest.scripts?.typecheck).toBe("tsc --noEmit");

    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    const privateFactoryPackages = Object.keys(deps).filter((name) =>
      name.startsWith("@factory/"),
    );
    expect(privateFactoryPackages).toEqual([]);
  });

  it("builds the exact Factory latest-version reported by the check job", () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, ".github", "workflows", "release.yml"),
      "utf-8",
    );

    expect(workflow).toContain("https://api.factory.ai/api/desktop/latest-version");
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("group: release-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain("Resolve Linux droid CLI");
    expect(workflow).not.toContain("node dist/cli.js resolve-droid");
    expect(workflow).not.toContain("FACTORY_DROID_PATH=$GITHUB_WORKSPACE/work/droid/droid");
    expect(workflow).toContain("node dist/cli.js build-all");
    expect(workflow).toContain(
      '--factory-version "${{ needs.check-and-release.outputs.version }}"',
    );
    expect(workflow).not.toContain("node dist/cli.js build-all --targets");
  });

  it("stages packaging scripts into the updater builder bundle", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf-8");

    expect(cli).toContain('for (const dir of ["dist", "node_modules", "src", "assets", "packaging"])');
    expect(cli).toContain("verbatimSymlinks: true");
  });

  it("retains the Electron build runtime when pruning updater dependencies", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf-8");

    expect(manifest.devDependencies?.electron).toBeDefined();
    expect(manifest.devDependencies?.["electron-builder"]).toBeDefined();
    expect(cli).toContain('["electron", "electron-builder"]');
    expect(cli).toContain("installManifest.dependencies[dependency] = version");
    expect(cli).toContain("delete installManifest.devDependencies[dependency]");
    expect(cli).toContain("fs.writeFileSync(stagedPackageJson, originalPackageJson)");
  });

  it("keeps the staged 7zip compressor executable for updater rebuilds", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf-8");

    expect(cli).toMatch(
      /path\.join\(\s*stagedNodeModules,\s*"7zip-bin",\s*"linux",\s*"x64",\s*"7za",?\s*\)/,
    );
    expect(cli).toContain("fs.chmodSync(staged7za, 0o755)");
  });

  it("preserves the installed port SHA during updater-driven rebuilds", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf-8");
    const builder = fs.readFileSync(path.join(repoRoot, "updater", "src", "builder.rs"), "utf-8");

    expect(cli).toContain("process.env.GITHUB_SHA ?? process.env.FACTORY_PORT_BUILD_SHA ?? null");
    expect(builder).toContain('build.env("FACTORY_PORT_BUILD_SHA", installed_port_sha)');
  });
});
