import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { readSafeZip } from "./SafeZip";
function storedZip(name: string, data: Buffer, external = 0): Buffer {
  const filename = Buffer.from(name); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(external >>> 0, 38); central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + filename.length, 12); eocd.writeUInt32LE(30 + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, eocd]);
}
function forgedDeflatedZip(name: string, expanded: Buffer, declaredSize: number): Buffer { const filename = Buffer.from(name); const data = deflateRawSync(expanded); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(declaredSize, 22); local.writeUInt16LE(filename.length, 26); const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(declaredSize, 24); central.writeUInt16LE(filename.length, 28); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + filename.length, 12); eocd.writeUInt32LE(30 + filename.length + data.length, 16); return Buffer.concat([local, filename, data, central, filename, eocd]); }
describe("safe zip", () => {
  it("reads stored files", () => expect(readSafeZip(storedZip("SKILL.md", Buffer.from("ok")))[0].data.toString()).toBe("ok"));
  it("rejects traversal", () => expect(() => readSafeZip(storedZip("../escape", Buffer.from("x")))).toThrow(/不安全/));
  it("rejects absolute paths", () => expect(() => readSafeZip(storedZip("/escape", Buffer.from("x")))).toThrow(/不安全/));
  it("rejects symlinks", () => expect(() => readSafeZip(storedZip("link", Buffer.from("target"), 0xa000 << 16))).toThrow(/符号链接/));
  it("enforces size limits", () => expect(() => readSafeZip(storedZip("large", Buffer.alloc(10)), { maxFileBytes: 5 })).toThrow(/过大/));
  it("caps actual inflate output despite forged headers", () => expect(() => readSafeZip(forgedDeflatedZip("bomb", Buffer.alloc(1000), 1), { maxFileBytes: 10 })).toThrow());
});
