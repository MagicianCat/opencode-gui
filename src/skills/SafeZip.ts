import { inflateRawSync } from "node:zlib";
import * as path from "node:path";
export interface ZipEntry { name: string; data: Buffer; directory: boolean; }
export interface ZipLimits { maxEntries: number; maxFileBytes: number; maxTotalBytes: number; }
const DEFAULT_LIMITS: ZipLimits = { maxEntries: 2000, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 250 * 1024 * 1024 };

export function readSafeZip(buffer: Buffer, limits: Partial<ZipLimits> = {}): ZipEntry[] {
  const resolved = { ...DEFAULT_LIMITS, ...limits }; const eocd = findEocd(buffer); const count = buffer.readUInt16LE(eocd + 10); const centralSize = buffer.readUInt32LE(eocd + 12); const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("不支持 ZIP64");
  if (count > resolved.maxEntries) throw new Error("ZIP 文件数量超过限制");
  if (centralOffset > buffer.length || centralOffset + centralSize > eocd) throw new Error("ZIP 中央目录越界");
  const entries: ZipEntry[] = []; const names = new Set<string>(); let offset = centralOffset; let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
    const flags = buffer.readUInt16LE(offset + 8); const method = buffer.readUInt16LE(offset + 10); const compressed = buffer.readUInt32LE(offset + 20); const uncompressed = buffer.readUInt32LE(offset + 24); const nameLength = buffer.readUInt16LE(offset + 28); const extraLength = buffer.readUInt16LE(offset + 30); const commentLength = buffer.readUInt16LE(offset + 32); const external = buffer.readUInt32LE(offset + 38); const localOffset = buffer.readUInt32LE(offset + 42); const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > eocd) throw new Error("ZIP 中央目录条目越界"); if (flags & 1) throw new Error("不支持加密 ZIP");
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/"); validateName(name); if (names.has(name)) throw new Error(`ZIP 包含重复路径: ${name}`); names.add(name);
    const unixMode = external >>> 16; if ((unixMode & 0xf000) === 0xa000) throw new Error(`ZIP 不允许符号链接: ${name}`);
    if (uncompressed > resolved.maxFileBytes) throw new Error(`ZIP 文件过大: ${name}`); if (total + uncompressed > resolved.maxTotalBytes) throw new Error("ZIP 解压总大小超过限制");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("ZIP 本地文件头损坏"); const localNameLength = buffer.readUInt16LE(localOffset + 26); const localExtraLength = buffer.readUInt16LE(localOffset + 28); const start = localOffset + 30 + localNameLength + localExtraLength; const end = start + compressed; if (start < localOffset || end > centralOffset || end > buffer.length) throw new Error(`ZIP 文件数据越界: ${name}`);
    const payload = buffer.subarray(start, end); const directory = name.endsWith("/"); const outputLimit = Math.min(resolved.maxFileBytes, resolved.maxTotalBytes - total); const data = directory ? Buffer.alloc(0) : method === 0 ? Buffer.from(payload) : method === 8 ? inflateRawSync(payload, { maxOutputLength: outputLimit }) : unsupported(method);
    if (data.length !== uncompressed) throw new Error(`ZIP 文件大小不匹配: ${name}`); total += data.length; entries.push({ name, data, directory }); offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw new Error("ZIP 中央目录大小不匹配"); return entries;
}
function validateName(name: string): void { if (!name || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:\//.test(name) || path.posix.normalize(name).startsWith("../") || name.split("/").includes("..")) throw new Error(`ZIP 路径不安全: ${name}`); }
function findEocd(buffer: Buffer): number { for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) return i; throw new Error("无效 ZIP：缺少结束记录"); }
function unsupported(method: number): never { throw new Error(`不支持 ZIP 压缩方法 ${method}`); }
