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
    expect(workflow).toContain("node dist/cli.js build-all");
    expect(workflow).toContain(
      '--factory-version "${{ needs.check-and-release.outputs.version }}"',
    );
    expect(workflow).not.toContain("node dist/cli.js build-all --targets");
  });
});
