import { For, Show, createMemo } from "solid-js";
import { marked } from "marked";
import { vscode } from "./utils/vscode";

export interface AsdmTool { assetId: number; title: string }

export function citedAsdmTools(markdown: string): AsdmTool[] {
  const found = new Map<number, AsdmTool>();
  marked.walkTokens(marked.lexer(markdown), token => {
    if (token.type !== "link") return;
    try {
      const url = new URL(token.href, "http://agent.local");
      const match = /^\/asdm-tools\/download\/([1-9]\d*)\/?$/.exec(url.pathname);
      if (!match) return;
      const assetId = Number(match[1]);
      if (!Number.isSafeInteger(assetId)) return;
      found.set(assetId, { assetId, title: token.text.trim() || "ASDM 工具包" });
    } catch { /* Ignore malformed links. */ }
  });
  return [...found.values()];
}

export function AsdmDownloads(props: { content: string; installed?: boolean }) {
  const tools = createMemo(() => citedAsdmTools(props.content).slice(0, 1));
  return <Show when={tools().length}>
    <section class="wiki-downloads" aria-label="ASDM 工具包下载">
      <div class="wiki-downloads-head"><strong>ASDM 工具包</strong><Show when={props.installed}><span class="badge project">项目已安装</span></Show></div>
      <For each={tools()}>{tool => <div class="wiki-download-row">
        <span>{tool.title}</span>
        <button class="primary compact" onClick={() => vscode.postMessage({ type: "install-asdm-tool", assetId: tool.assetId })}>一键安装</button>
      </div>}</For>
    </section>
  </Show>;
}
