import { describe, expect, it } from "vitest";
import { citedAsdmTools } from "./AsdmDownloads";

describe("citedAsdmTools", () => {
  it("extracts a tool package link from the assistant answer", () => {
    expect(citedAsdmTools("[下载 ASDM 工具包](https://example.com/asdm-tools/download/42)")).toEqual([{ assetId: 42, title: "下载 ASDM 工具包" }]);
  });

  it("ignores unrelated and malformed links", () => {
    expect(citedAsdmTools("[Wiki](/wiki?documentId=42) [bad](/asdm-tools/download/0) [bad](/asdm-tools/download/42/extra)")).toEqual([]);
  });
});
