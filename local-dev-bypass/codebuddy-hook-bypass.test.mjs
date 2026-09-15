import assert from "node:assert/strict";
import test from "node:test";
import { addBypassHook } from "./codebuddy-hook-bypass.mjs";

test("adds a uniquely identifiable Skill hook without changing existing hooks", () => {
  const original = { description: "keep", hooks: { PostToolUse: [{ matcher: "Skill|skill", hooks: [{ type: "command", command: "probe" }] }] } };
  const updated = addBypassHook(original, "/tmp/capture.mjs");
  assert.equal(updated.description, "keep");
  assert.equal(updated.hooks.PostToolUse.length, 2);
  assert.equal(updated.hooks.PostToolUse[1]["x-yantu-bypass-id"], "yantu-local-dev-bypass");
  assert.match(updated.hooks.PostToolUse[1].hooks[0].command, /capture\.mjs/);
  assert.equal(original.hooks.PostToolUse.length, 1);
});

test("is idempotent", () => {
  const once = addBypassHook({ hooks: {} }, "/tmp/capture.mjs");
  const twice = addBypassHook(once, "/tmp/capture.mjs");
  assert.equal(twice.hooks.PostToolUse.length, 1);
});
