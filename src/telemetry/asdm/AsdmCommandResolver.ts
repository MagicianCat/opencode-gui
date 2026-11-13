import { promises as fs } from "node:fs";
import * as path from "node:path";

const commandNamePattern = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u;
const mappingPattern = /^@?\.asdm\/toolsets\/([^/]+)\/actions\/([^/]+\.md)$/u;
const maxEntryBytes = 4 * 1024;
const maxMarkerBytes = 4 * 1024;

export interface AsdmCommandEvidence {
  triggerType: "MENU" | "TYPED";
  promptPath?: string;
  readActionPaths?: string[];
}
export interface ResolvedAsdmCommand {
  commandName: string;
  toolsetName: string;
  actionName: string;
  actionPath: string;
  asdmAssetId?: number;
  sourceStatus: "source_resolved" | "source_missing" | "asset_marker_invalid";
}
export type AsdmCommandResolution = { command: ResolvedAsdmCommand; reason?: never } |
  { command?: never; reason: string };

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function evidenceMatches(value: string, relative: string, absolute: string): Promise<boolean> {
  const normalized = value.replace(/\\/g, "/").replace(/^@/, "");
  const actual = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const expectedRelative = process.platform === "win32" ? relative.toLowerCase() : relative;
  const expectedAbsolute = process.platform === "win32" ? absolute.replace(/\\/g, "/").toLowerCase() : absolute.replace(/\\/g, "/");
  if (actual === expectedRelative || actual === expectedAbsolute) return true;
  if (!path.isAbsolute(value)) return false;
  return await fs.realpath(value).catch(() => undefined) === await fs.realpath(absolute).catch(() => undefined);
}
async function readSmallFile(file: string, maximum: number): Promise<{ text: string; signature: string } | undefined> {
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) return undefined;
  const text = await fs.readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  return { text, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
}
async function signature(file: string): Promise<string | undefined> {
  const stat = await fs.lstat(file).catch(() => undefined);
  return stat && !stat.isSymbolicLink() ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` : undefined;
}

export async function resolveAsdmCommand(workspace: string, commandName: string,
    evidence: AsdmCommandEvidence): Promise<AsdmCommandResolution> {
  if (!commandNamePattern.test(commandName) || commandName === "." || commandName === "..")
    return { reason: "invalid_command_name" };
  const root = await fs.realpath(workspace).catch(() => undefined);
  if (!root || root === path.parse(root).root) return { reason: "workspace_unresolved" };
  const entry = path.join(root, ".codebuddy", "commands", `${commandName}.md`);
  if (await fs.realpath(entry).catch(() => undefined) !== entry) return { reason: "command_not_installed" };
  const definition = await readSmallFile(entry, maxEntryBytes);
  if (!definition) return { reason: "command_not_installed" };
  const lines = definition.text.replace(/\r?\n$/, "").split(/\r?\n/);
  const match = lines.length === 1 ? mappingPattern.exec(lines[0]!) : null;
  const toolsetName = match?.[1];
  const actionFile = match?.[2];
  if (!toolsetName || !actionFile || !commandNamePattern.test(toolsetName) ||
      !commandNamePattern.test(actionFile.slice(0, -3)) || toolsetName === ".." || actionFile === "...md")
    return { reason: "entry_invalid" };
  const actionPath = `.asdm/toolsets/${toolsetName}/actions/${actionFile}`;
  const actionFilePath = path.join(root, ".asdm", "toolsets", toolsetName, "actions", actionFile);
  const actualAction = await fs.realpath(actionFilePath).catch(() => undefined);
  if (!actualAction || !inside(root, actualAction) || actualAction !== actionFilePath ||
      !(await fs.lstat(actualAction).catch(() => undefined))?.isFile()) return { reason: "action_file_missing" };
  if (evidence.triggerType === "MENU" && evidence.promptPath &&
      !await evidenceMatches(evidence.promptPath, actionPath, actionFilePath)) return { reason: "prompt_mapping_mismatch" };
  if (evidence.triggerType === "TYPED" && !(await Promise.all((evidence.readActionPaths ?? []).map(read =>
      evidenceMatches(read, actionPath, actionFilePath)))).some(Boolean))
    return { reason: evidence.readActionPaths?.length ? "typed_action_mismatch" : "action_read_unverified" };
  const markerPath = path.join(root, ".asdm", ".yantu-platform-asdm.json");
  const marker = await readSmallFile(markerPath, maxMarkerBytes);
  let asdmAssetId: number | undefined;
  let sourceStatus: ResolvedAsdmCommand["sourceStatus"] = "source_missing";
  if (marker) {
    try {
      const value: unknown = JSON.parse(marker.text);
      const id = value && typeof value === "object" && !Array.isArray(value) ?
        (value as Record<string, unknown>).assetId : undefined;
      if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
        asdmAssetId = id; sourceStatus = "source_resolved";
      } else sourceStatus = "asset_marker_invalid";
    } catch { sourceStatus = "asset_marker_invalid"; }
  } else if (await fs.lstat(markerPath).catch(() => undefined)) sourceStatus = "asset_marker_invalid";
  if (await signature(entry) !== definition.signature || marker && await signature(markerPath) !== marker.signature)
    return { reason: "entry_changed" };
  return { command: { commandName, toolsetName, actionName: actionFile.slice(0, -3), actionPath,
    asdmAssetId, sourceStatus } };
}
