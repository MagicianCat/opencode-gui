import { describe, expect, it } from "vitest";
import { addInstallStatus } from "./SkillScanner";
describe("local skill status", () => {
  it("prefers project and detects updates", () => {
    const result = addInstallStatus([{ skillKey: "java", version: "2.0.0", status: "missing" }, { skillKey: "go", version: "1.0.0", status: "missing" }], [{ skillKey: "java", version: "1.0.0", directory: "/p", scope: "project" }]);
    expect(result.map(item => item.status)).toEqual(["update", "missing"]);
  });
});
