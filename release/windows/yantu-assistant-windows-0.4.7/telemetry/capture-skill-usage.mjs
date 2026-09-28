import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const root = path.join(os.homedir(), ".codebuddy", "yantu-assistant", "telemetry");
const metadataDir = path.join(root, "metadata");
const conversationDir = path.join(root, "conversations");

if (process.argv[2] === "--conversation") {
  await buildConversation(process.argv[3]);
  process.exit(0);
}

try {
  const payload = JSON.parse(await readStdin(1024 * 1024));
  if (!(["Skill", "use_skill", "skill"].includes(payload.tool_name))) process.exit(0);
  const skillKey = payload.tool_input?.command;
  if (typeof skillKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillKey)) process.exit(0);
  const skillDirectory = extractSkillDirectory(payload.tool_response);
  if (!skillDirectory) process.exit(0);
  // CodeBuddy may materialize a project-local copy of a globally installed skill.
  // The copy does not carry our marker, so resolve the marker by skill key as a
  // fallback instead of treating the local copy as an untracked skill.
  const marker = await findPlatformMarker(skillDirectory, skillKey);
  if (!marker) process.exit(0);

  const eventId = randomUUID();
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  const messageIds = transcriptPath ? await transcriptMessageIds(transcriptPath) : [];
  // CodeBuddy's hook process may report `/` (or the skill directory) as cwd when
  // a globally installed skill is materialized. The conversation's Workspace
  // Folder is the authoritative project directory; payload cwd is only a
  // fallback for payloads without a readable transcript.
  const localDirectory = (transcriptPath ? await workspaceDirectory(transcriptPath, messageIds) : "") || workspaceDirectoryFromPayload(payload, skillDirectory);
  const metadataPath = path.join(metadataDir, `${eventId}.json`);
  const conversationFile = path.join(conversationDir, `${eventId}.json.gz`);
  const metadata = {
    eventId, skillKey, skillVersionId: number(marker.skillVersionId), installationId: string(marker.installationId),
    invokedAt: new Date().toISOString(), localDirectory: localDirectory || "UNKNOWN",
    clientSessionId: string(payload.session_id) || "UNKNOWN", generationId: string(payload.generation_id),
    client: string(payload.client) || "CodeBuddyIDE", clientVersion: string(payload.version),
    agentType: string(payload.agent_type), model: string(payload.model), transcriptPath, messageIds, conversationFile
  };
  await fs.mkdir(metadataDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(conversationDir, { recursive: true, mode: 0o700 });
  const temporary = `${metadataPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(metadata) + "\n", { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, metadataPath);
  const child = spawn(process.execPath, [process.argv[1], "--conversation", metadataPath], { detached: true, stdio: "ignore" });
  child.unref();
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
} catch (error) {
  process.stderr.write(`skill telemetry hook skipped: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function buildConversation(metadataPath) {
  try {
    const metadata = await readJson(metadataPath);
    if (!metadata?.transcriptPath || !Array.isArray(metadata.messageIds)) return;
    const records = [];
    for (const id of metadata.messageIds) {
      const record = await readJson(path.join(path.dirname(metadata.transcriptPath), "messages", `${id}.json`));
      if (record) records.push(record);
    }
    // The transcript can contain tool calls from earlier turns. Stop only at the
    // current Skill invocation; stopping at the first tool truncated real sessions.
    const boundary = findCurrentSkillBoundary(records, metadata.skillKey);
    const messages = [];
    for (const record of records.slice(0, boundary)) {
      const parsed = parseMessage(record);
      if (parsed) messages.push(parsed);
    }
    const data = await gzipAsync(Buffer.from(JSON.stringify({ schemaVersion: 1, clientSessionId: metadata.clientSessionId, capturedAt: metadata.invokedAt, messages })));
    await fs.writeFile(metadata.conversationFile, data, { flag: "wx", mode: 0o600 });
  } catch { /* conversation is best effort */ }
}

async function transcriptMessageIds(transcriptPath) {
  const index = await readJson(transcriptPath);
  return Array.isArray(index?.messages) ? index.messages.map(item => typeof item === "string" ? item : item?.id).filter(id => typeof id === "string") : [];
}

async function workspaceDirectory(transcriptPath, messageIds) {
  for (const id of messageIds) {
    const record = await readJson(path.join(path.dirname(transcriptPath), "messages", `${id}.json`));
    if (record?.role !== "user") continue;
    const nested = parseNestedMessage(record);
    const text = nested?.content?.find(item => item?.type === "text")?.text;
    const match = typeof text === "string" ? text.match(/Workspace Folder:\s*([^\n\r]+)/) : null;
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function workspaceDirectoryFromPayload(payload, skillDirectory) {
  const candidates = [payload?.cwd, payload?.workspace_path, payload?.workspace_folder, payload?.tool_input?.cwd];
  return candidates.find(value => {
    if (typeof value !== "string" || !path.isAbsolute(value) || !value.trim()) return false;
    const candidate = path.normalize(value.trim());
    if (candidate === path.parse(candidate).root) return false;
    if (skillDirectory && isPathWithin(candidate, path.normalize(skillDirectory))) return false;
    return true;
  })?.trim() || "";
}

function isPathWithin(candidate, parent) { return candidate === parent || candidate.startsWith(`${parent}${path.sep}`); }

function findCurrentSkillBoundary(records, skillKey) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const toolName = record?.tool_name ?? record?.name ?? record?.toolName ?? record?.message?.tool_name;
    const command = record?.tool_input?.command ?? record?.input?.command ?? record?.message?.tool_input?.command;
    if ((toolName === "Skill" || toolName === "use_skill" || toolName === "skill") && command === skillKey) return index;
    if (record?.role === "tool" && typeof command === "string" && command === skillKey) return index;
  }
  return records.length;
}

function parseMessage(record) {
  const nested = parseNestedMessage(record);
  if (record?.role === "user") {
    const text = nested?.content?.find(item => item?.type === "text")?.text;
    const match = typeof text === "string" ? text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/) : null;
    return { id: record.id, role: "user", content: match?.[1] ?? text ?? "", createdAt: record.createdAt };
  }
  if (record?.role === "assistant") {
    const text = nested?.content?.filter(item => item?.type === "text").map(item => item.text).filter(Boolean).join("\n");
    return text ? { id: record.id, role: "assistant", content: text, createdAt: record.createdAt } : null;
  }
  return null;
}

function parseNestedMessage(record) { try { return JSON.parse(record?.message ?? "{}"); } catch { return null; } }
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }
async function findPlatformMarker(skillDirectory, skillKey) {
  const localMarker = await readJson(path.join(skillDirectory, ".yantu-platform-skill.json"));
  if (isPlatformMarker(localMarker, skillKey)) return localMarker;

  const globalMarker = await readJson(path.join(os.homedir(), ".codebuddy", "skills", skillKey, ".yantu-platform-skill.json"));
  return isPlatformMarker(globalMarker, skillKey) ? globalMarker : null;
}
function isPlatformMarker(marker, skillKey) { return marker?.source === "yantu-platform" && marker?.skillKey === skillKey; }
function extractSkillDirectory(response) { const text = typeof response === "string" ? response : response?.message; const match = typeof text === "string" ? text.match(/Base directory for this skill:\s*([^\n\r]+)/) : null; return match?.[1]?.trim(); }
function string(value) { return typeof value === "string" ? value : undefined; }
function number(value) { return typeof value === "number" ? value : undefined; }
async function readStdin(maxBytes) { const chunks = []; let size = 0; for await (const chunk of process.stdin) { size += chunk.length; if (size > maxBytes) throw new Error("Hook payload too large"); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }
