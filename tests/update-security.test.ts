import * as fs from "fs";
import * as path from "path";

describe("Factory update privilege boundary", () => {
  it("requires administrator authorization for package installation and rollback", () => {
    const policy = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "packaging",
        "linux",
        "org.factory.desktop.update-manager.policy",
      ),
      "utf-8",
    );

    expect(policy.match(/<allow_active>auth_admin_keep<\/allow_active>/g)).toHaveLength(2);
    expect(policy).not.toContain("<allow_active>yes</allow_active>");
  });
});
