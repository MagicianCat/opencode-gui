// Temporary Windows private-deployment probe. Records only tool/event names and
// payload field names; never stores prompt, tool input values, or responses.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const logFile = path.join(os.homedir(), ".codebuddy", "yantu-assistant", "telemetry", "probe", "post-tool-names.log");

try {
  const payload = JSON.parse(await readStdin(1024 * 1024));
  const entry = {
    timestamp: new Date().toISOString(),
    hookEvent: text(payload.hook_event_name) ?? text(payload.hookEventName) ?? text(payload.event),
    toolName: text(payload.tool_name) ?? text(payload.toolName) ?? text(payload.name),
    topLevelKeys: objectKeys(payload),
    toolInputKeys: objectKeys(payload.tool_input ?? payload.toolInput ?? payload.input),
    toolResponseType: valueType(payload.tool_response ?? payload.toolResponse ?? payload.response),
  };
  await fs.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
  try { if ((await fs.stat(logFile)).size > 512 * 1024) await fs.rename(logFile, `${logFile}.previous`); } catch { /* first entry */ }
  await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
} catch { /* diagnostic probe must never affect CodeBuddy */ }

process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));

function text(value) { return typeof value === "string" && value ? value : undefined; }
function objectKeys(value) { return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : []; }
function valueType(value) { return value === null ? "null" : Array.isArray(value) ? "array" : typeof value; }
async function readStdin(maxBytes) { const chunks = []; let size = 0; for await (const chunk of process.stdin) { size += chunk.length; if (size > maxBytes) throw new Error("payload too large"); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }
