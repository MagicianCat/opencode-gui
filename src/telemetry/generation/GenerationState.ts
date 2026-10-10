// Generation 本地状态：日志采集器或兼容 hook 按事件增量写入，扩展进程聚合并上报。
// 一次 User Prompt 对应一个 Generation；状态文件按 generationId 落盘，避免并发互相覆盖。

/** 一次 Skill 调用记录（关联到 Generation）。 */
export interface SkillInvocation {
  skillKey: string;
  skillVersionId?: number;
  invokedAt: string;
}

/** 单个文件的代码量 diff 统计。 */
export interface FileDiffMetric {
  filePath: string;
  extension: string;
  category: string;
  linesAdded: number;
  linesDeleted: number;
  created: boolean;
  modified: boolean;
}

/** Token 汇总（来自 CodeBuddyUsageProvider，Stop 时填充）。 */
export interface GenerationTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  thinkingTokens?: number;
  modelCallCount?: number;
  lastTokens?: number;
  source?: string;
  quality?: string;
}

/** Generation 全量本地状态。 */
export interface GenerationState {
  generationId: string;
  sessionId: string;
  clientInstallationId?: string;
  cwd?: string;

  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "PARTIAL";

  // 项目维度（ProjectResolver 在首个事件时解析一次）。
  projectKey?: string;
  projectName?: string;
  projectSource?: string;

  skillInvocations: SkillInvocation[];
  fileDiffs: FileDiffMetric[];

  toolCallCount: number;
  toolFailureCount: number;

  usage?: GenerationTokenUsage;

  /** 最近一次状态更新时间（epoch ms），用于 PARTIAL 兜底判断。 */
  updatedAtMs: number;
}

export function emptyGeneration(generationId: string, sessionId: string, startedAt: string): GenerationState {
  return {
    generationId, sessionId, startedAt, status: "RUNNING",
    skillInvocations: [], fileDiffs: [], toolCallCount: 0, toolFailureCount: 0,
    updatedAtMs: Date.now(),
  };
}
