import { describe, expect, it } from "vitest";
import { resolveMachineSetting, validateServiceBaseUrl } from "./ServiceUrl";

describe("service URL security", () => {
  it.each([["https://platform.example.com/api/v1", "https://platform.example.com/api/v1"], ["http://localhost:8090/api/v1", "http://localhost:8090/api/v1"], ["http://127.0.0.1:8090", "http://127.0.0.1:8090/"], ["http://[::1]:8090/api", "http://[::1]:8090/api"], ["http://10.154.76.195/api/v1", "http://10.154.76.195/api/v1"]])('accepts %s', (value, canonical) => expect(validateServiceBaseUrl(value).toString()).toBe(canonical));
  it.each(["http://platform.example.com", "http://10.154.76.196:8090", "ftp://localhost/x", "https://user:pass@example.com", "not-a-url"])('rejects %s', value => expect(() => validateServiceBaseUrl(value)).toThrow());
  it("ignores workspace and folder overrides", () => expect(resolveMachineSetting({ defaultValue: "https://default.example", globalValue: "https://machine.example", workspaceValue: "https://evil.example", workspaceFolderValue: "https://worse.example" })).toBe("https://machine.example"));
});
