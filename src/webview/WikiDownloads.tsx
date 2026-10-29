import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { marked } from "marked";
import { vscode } from "./utils/vscode";
import { parseHostMessage } from "../shared/messages";

const [wikiTitles, setWikiTitles] = createSignal<Record<number, string>>({});
const requestedTitles = new Set<number>();
window.addEventListener("message", event => {
  const message = parseHostMessage(event.data);
  if (message?.type === "wiki-metadata") setWikiTitles(current => ({ ...current, [message.documentId]: message.title }));
});

interface WikiDocument { id: number; title: string }
function wikiId(href: string): number | undefined {
  try { const url = new URL(href, "http://agent.local"); const raw = url.pathname === "/wiki" ? url.searchParams.get("documentId") : null;
    if (!raw || !/^[1-9]\d*$/.test(raw)) return undefined;
    const id = Number(raw); return Number.isSafeInteger(id) ? id : undefined;
  } catch { return undefined; }
}
function citedDocuments(markdown: string): WikiDocument[] {
  const found = new Map<number, WikiDocument>();
  marked.walkTokens(marked.lexer(markdown), token => {
    if (token.type !== "link") return;
    const id = wikiId(token.href); if (!id) return;
    const label = token.text.trim();
    const title = label && !/^(原文|下载|下载 Markdown|查看原文)$/i.test(label) ? label : `Wiki 文档 #${id}`;
    const previous = found.get(id);
    if (!previous) found.set(id, { id, title });
    else if (previous.title.startsWith("Wiki 文档 #") && !title.startsWith("Wiki 文档 #")) previous.title = title;
  });
  return [...found.values()];
}
export function WikiDownloads(props: { content: string }) {
  const documents = createMemo(() => citedDocuments(props.content));
  createEffect(() => {
    for (const document of documents()) {
      if (requestedTitles.has(document.id)) continue;
      requestedTitles.add(document.id);
      vscode.postMessage({ type: "wiki-metadata-request", documentId: document.id });
    }
  });
  const [selection, setSelection] = createSignal<number[] | undefined>();
  const selected = () => selection() ?? documents().slice(0, 20).map(document => document.id);
  const toggle = (id: number) => setSelection(current => {
    const ids = current ?? documents().slice(0, 20).map(document => document.id);
    return ids.includes(id) ? ids.filter(value => value !== id) : ids.length < 20 ? [...ids, id] : ids;
  });
  return <Show when={documents().length}>
    <section class="wiki-downloads" aria-label="引用的 Wiki 文档">
      <div class="wiki-downloads-head"><strong>引用的 Wiki 文档</strong><button onClick={() => setSelection(documents().slice(0, 20).map(document => document.id))}>全选</button></div>
      <For each={documents()}>{document => <div class="wiki-download-row">
        <label><input type="checkbox" checked={selected().includes(document.id)} onChange={() => toggle(document.id)} />{wikiTitles()[document.id] ?? (document.title.startsWith("Wiki 文档 #") ? "正在读取文档名称…" : document.title)}</label>
        <button onClick={() => vscode.postMessage({ type: "download-wiki", documentIds: [document.id] })}>下载</button>
      </div>}</For>
      <button class="primary compact" disabled={!selected().length} onClick={() => vscode.postMessage({ type: "download-wiki", documentIds: selected().slice(0, 20) })}>一键下载（{selected().length}）</button>
      <Show when={documents().length > 20}><small>每次最多选择 20 篇文档</small></Show>
    </section>
  </Show>;
}
