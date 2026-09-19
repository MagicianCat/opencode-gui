import type { FileDiffMetric } from "./GenerationState";

export interface FileTypeAggregate {
  type: string;
  extension: string;
  linesAdded: number;
  linesDeleted: number;
  filesCreated: number;
  filesModified: number;
}

/** 把单文件 diff 列表按文件类别聚合成后端 fileTypes 结构（同一类别多文件合并）。 */
export function aggregateFileTypes(diffs: FileDiffMetric[]): FileTypeAggregate[] {
  const byCategory = new Map<string, FileTypeAggregate>();
  for (const diff of diffs) {
    const key = diff.category || "OTHER";
    let agg = byCategory.get(key);
    if (!agg) {
      agg = { type: key, extension: diff.extension || "", linesAdded: 0, linesDeleted: 0, filesCreated: 0, filesModified: 0 };
      byCategory.set(key, agg);
    }
    agg.linesAdded += diff.linesAdded;
    agg.linesDeleted += diff.linesDeleted;
    if (diff.created) agg.filesCreated += 1;
    if (diff.modified) agg.filesModified += 1;
  }
  return [...byCategory.values()];
}
