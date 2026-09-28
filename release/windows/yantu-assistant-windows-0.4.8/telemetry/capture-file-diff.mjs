// Write/Edit 代码量采集（CodeBuddy Hook，独立 node 进程）。
// 用法：node capture-file-diff.mjs Pre | Post
//   Pre  （PreToolUse Write|Edit）  ：读 Before（磁盘现状，可能不存在）存快照。
//   Post （PostToolUse Write|Edit） ：读 After（磁盘现状）与 Before diff，统计行数写入当前 Generation。
// 口径：只统计 Write/Edit 两个工具；只保存统计值，不上传源码正文（文档 §14、§42）。
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

// 文件类型分类（内联，保证 hook 脚本自包含运行）。与后端 FileCategory 枚举一致。
const EXTENSION_TO_CATEGORY = {
  java: "JAVA", kt: "KOTLIN", kts: "KOTLIN",
  js: "JAVASCRIPT", jsx: "JAVASCRIPT", mjs: "JAVASCRIPT", cjs: "JAVASCRIPT",
  ts: "TYPESCRIPT", tsx: "TYPESCRIPT", mts: "TYPESCRIPT", cts: "TYPESCRIPT",
  vue: "VUE", html: "HTML", htm: "HTML",
  css: "CSS", scss: "CSS", sass: "CSS", less: "CSS",
  sql: "SQL", xml: "XML", xsd: "XML", pom: "XML",
  yaml: "YAML", yml: "YAML", json: "JSON", jsonc: "JSON", json5: "JSON",
  py: "PYTHON", go: "GO", sh: "SHELL", bash: "SHELL", zsh: "SHELL",
  md: "MARKDOWN", markdown: "MARKDOWN",
  properties: "CONFIG", ini: "CONFIG", conf: "CONFIG", config: "CONFIG", toml: "CONFIG", env: "CONFIG",
};
function extensionOf(filePath) {
  const name = String(filePath || "").split(/[\\/]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
function classifyFile(filePath) {
  const extension = extensionOf(filePath);
  return { extension, category: EXTENSION_TO_CATEGORY[extension] || "OTHER" };
}

const root = path.join(os.homedir(), ".codebuddy", "yantu-assistant", "telemetry");
const generationsDir = path.join(root, "generations");
const snapshotsDir = path.join(root, "file-snapshots");

const phase = process.argv[2] || "";

try {
  const payload = JSON.parse(await readStdin(8 * 1024 * 1024));
  const filePath = extractFilePath(payload);
  if (filePath && isTextualPath(filePath)) {
    if (phase === "Pre") await onPre(payload, filePath);
    else if (phase === "Post") await onPost(payload, filePath);
  }
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
} catch (error) {
  process.stderr.write(`file-diff hook (${phase}) skipped: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

// ---- Pre：保存 Before 快照 ----
async function onPre(payload, filePath) {
  const before = await readFileOrNull(filePath);
  const snapshot = {
    filePath,
    sessionId: str(payload.session_id),
    generationId: str(payload.generation_id) || str(payload.message_id),
    existed: before !== null,
    before, // 可能为 null（新文件）
    capturedAt: Date.now(),
  };
  await fs.mkdir(snapshotsDir, { recursive: true, mode: 0o700 });
  const target = snapshotFile(payload, filePath);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  await fs.rename(tmp, target);
}

// ---- Post：Before vs After diff ----
async function onPost(payload, filePath) {
  const snapshot = await readJson(snapshotFile(payload, filePath));
  const after = await readFileOrNull(filePath);
  const toolName = str(payload.tool_name) || "Write";

  let linesAdded = 0, linesDeleted = 0, created = false, modified = false;
  if (snapshot && snapshot.existed) {
    // 已存在文件被覆盖/编辑
    const diff = diffLines(snapshot.before ?? "", after ?? "");
    linesAdded = diff.added; linesDeleted = diff.deleted; modified = true;
  } else {
    // 新文件：After 全部计为新增
    created = true;
    linesAdded = after === null ? 0 : countLines(after);
  }

  const { extension, category } = classifyFile(filePath);
  const metric = { filePath, extension, category, linesAdded, linesDeleted, created, modified };

  await removeFile(snapshotFile(payload, filePath)); // 快照一次性使用
  await appendToGeneration(payload, metric, toolName);
}

// 把 diff 统计并入当前 Generation，并累计 toolCallCount（Write/Edit 在此计数，capture-generation 不再重复）。
async function appendToGeneration(payload, metric, toolName) {
  const generationId = str(payload.generation_id) || str(payload.message_id);
  let state = generationId ? await readJson(path.join(generationsDir, safe(generationId) + ".json")) : null;
  if (!state) state = await latestRunning(str(payload.session_id));
  if (!state) return; // 无对应 Generation
  state.fileDiffs.push(metric);
  state.toolCallCount = (state.toolCallCount || 0) + 1;
  await saveGeneration(state);
}

// ---- diff 工具 ----

// 逐行 diff：返回 {added, deleted}。简单 LCS 行级对齐，避免 Write 覆盖时整文件重复计。
function diffLines(before, after) {
  const a = splitLines(before), b = splitLines(after);
  const lcs = lcsLength(a, b);
  return { added: b.length - lcs, deleted: a.length - lcs };
}

function splitLines(text) {
  if (!text) return [];
  // 兼容 CRLF / LF。
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

// 标准 LCS 长度（行级），对超大文件退化为简单前缀/后缀对齐以控制开销。
function lcsLength(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return 0;
  if (n * m > 4_000_000) { // 超大文件：用公共前缀+后缀估算，避免 O(n*m) 内存
    let pre = 0;
    while (pre < n && pre < m && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
    return pre + suf;
  }
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev.fill(0)];
  }
  return prev[m];
}

function countLines(text) {
  if (!text) return 0;
  return splitLines(text).length;
}

// ---- 文件 / 状态工具 ----

function extractFilePath(payload) {
  const p = payload.tool_input?.file_path ?? payload.tool_input?.path ?? payload.tool_input?.filePath;
  return typeof p === "string" && p ? p : null;
}

// 跳过明显二进制文件（按扩展名粗判）。
function isTextualPath(p) {
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|jar|class|so|dll|exe|bin|woff2?|ttf|mp4|mov)$/i.test(p);
}

async function readFileOrNull(p) {
  try {
    const buf = await fs.readFile(p);
    if (buf.includes(0)) return null; // 含 NUL 视为二进制，不计行数
    return buf.toString("utf8");
  } catch { return null; }
}

function snapshotFile(payload, filePath) {
  const key = `${str(payload.session_id) || "nosession"}:${str(payload.generation_id) || str(payload.message_id) || "nogeneration"}:${filePath}`;
  return path.join(snapshotsDir, createHashHex(key) + ".json");
}

async function latestRunning(sessionId) {
  if (!sessionId) return null;
  let names;
  try { names = await fs.readdir(generationsDir); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let s;
    try { s = JSON.parse(await fs.readFile(path.join(generationsDir, name), "utf8")); } catch { continue; }
    if (s.sessionId === sessionId && s.status === "RUNNING") {
      if (!best || (s.updatedAtMs || 0) > (best.updatedAtMs || 0)) best = s;
    }
  }
  return best;
}

async function saveGeneration(state) {
  state.updatedAtMs = Date.now();
  const target = path.join(generationsDir, safe(state.generationId) + ".json");
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(tmp, target);
}

async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }
async function removeFile(file) { try { await fs.unlink(file); } catch { /* gone */ } }
function safe(id) { return String(id).replace(/[^A-Za-z0-9._-]/g, "_"); }
function str(v) { return typeof v === "string" && v ? v : undefined; }
function createHashHex(s) { return createHash("sha256").update(s).digest("hex"); }

async function readStdin(maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("hook payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
