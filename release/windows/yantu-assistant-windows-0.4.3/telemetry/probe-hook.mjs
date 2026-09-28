// 探针：把 CodeBuddy 各生命周期 Hook 的原始 stdin 落盘，用于确认 Stop Hook 是否携带汇总 usage。
// 仅诊断用途，不改变主流程；采集到的 payload 写入 ~/.codebuddy/yantu-assistant/telemetry/probe/。
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const probeDir = path.join(os.homedir(), ".codebuddy", "yantu-assistant", "telemetry", "probe");
const hookName = process.argv[2] || "unknown";

async function readStdin(maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const raw = await readStdin(4 * 1024 * 1024);
  await fs.mkdir(probeDir, { recursive: true, mode: 0o700 });
  const file = path.join(probeDir, `${hookName}-${Date.now()}.json`);
  await fs.writeFile(file, raw, { flag: "wx", mode: 0o600 });
} catch { /* best effort */ }

// 不阻塞 CodeBuddy：必须回传 continue。
process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
