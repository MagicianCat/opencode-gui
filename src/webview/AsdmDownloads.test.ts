import { describe, expect, it } from "vitest";
import { citedAsdmTools } from "./AsdmDownloads";

describe("citedAsdmTools", () => {
  it("extracts a tool package link from the assistant answer", () => {
    expect(citedAsdmTools("[下载 ASDM 工具包](https://example.com/asdm-tools/download/42)")).toEqual([{ assetId: 42, title: "下载 ASDM 工具包" }]);
  });

  it("ignores unrelated and malformed links", () => {
    expect(citedAsdmTools("[Wiki](/wiki?documentId=42) [bad](/asdm-tools/download/0) [bad](/asdm-tools/download/42/extra)")).toEqual([]);
  });

  it("keeps every distinct ASDM download link in one answer", () => {
    expect(citedAsdmTools("[工具 A](/asdm-tools/download/5) [工具 B](/asdm-tools/download/6) [工具 A](/asdm-tools/download/5)")).toEqual([
      { assetId: 5, title: "工具 A" },
      { assetId: 6, title: "工具 B" },
    ]);
  });
});
