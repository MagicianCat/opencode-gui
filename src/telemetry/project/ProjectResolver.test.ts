import { describe, expect, it } from "vitest";
import { normalizeGitRemote } from "./ProjectResolver";

describe("normalizeGitRemote", () => {
  it("normalizes https and ssh forms of the same repo to one key", () => {
    expect(normalizeGitRemote("https://github.com/org/repo.git")).toBe("github.com/org/repo");
    expect(normalizeGitRemote("git@github.com:org/repo.git")).toBe("github.com/org/repo");
    expect(normalizeGitRemote("https://user@github.com/org/repo")).toBe("github.com/org/repo");
  });
  it("strips trailing slashes and lowercases", () => {
    expect(normalizeGitRemote("HTTPS://GitHub.COM/Org/Repo/")).toBe("github.com/org/repo");
  });
  it("keeps non-git suffix path segments", () => {
    expect(normalizeGitRemote("git@code.example.com:team/sub/proj.git")).toBe("code.example.com/team/sub/proj");
  });
});
