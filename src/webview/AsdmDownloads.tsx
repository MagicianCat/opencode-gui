import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { marked } from "marked";
import { vscode } from "./utils/vscode";
import { parseHostMessage } from "../shared/messages";

const [titles, setTitles] = createSignal<Record<number, string>>({});
const requested = new Set<number>();
if (typeof window !== "undefined") window.addEventListener("message", event => {
  const message = parseHostMessage(event.data);
  if (message?.type === "asdm-metadata") setTitles(current => ({ ...current, [message.assetId]: message.title }));
});

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

export function AsdmDownloads(props: { content: string; installed?: boolean; expanded: boolean; onToggle: () => void }) {
  const tools = createMemo(() => citedAsdmTools(props.content));
  createEffect(() => { for (const tool of tools()) if (!requested.has(tool.assetId)) { requested.add(tool.assetId); vscode.postMessage({ type: "asdm-metadata-request", assetId: tool.assetId }); } });
  const title = (tool: AsdmTool) => titles()[tool.assetId] || (/^https?:\/\//i.test(tool.title) ? "正在读取工具包名称…" : tool.title);
  return <Show when={tools().length}>
    <section class="wiki-downloads" aria-label="ASDM 工具包下载">
      <div class="wiki-downloads-head"><button class="resource-fold-toggle" aria-expanded={props.expanded} onClick={props.onToggle}><span aria-hidden="true">{props.expanded ? "▾" : "▸"}</span><strong>ASDM 工具包（{tools().length}）</strong></button><Show when={props.installed}><span class="badge project">项目已安装</span></Show></div>
      <Show when={props.expanded}>
      <For each={tools()}>{tool => <div class="wiki-download-row">
        <span>{title(tool)}</span>
        <button class="primary compact" disabled={titles()[tool.assetId] === "工具包已不可访问"} onClick={() => vscode.postMessage({ type: "install-asdm-tool", assetId: tool.assetId })}>一键安装</button>
      </div>}</For>
      </Show>
    </section>
  </Show>;
}
