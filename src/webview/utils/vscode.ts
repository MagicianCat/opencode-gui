import type { WebviewMessage } from "../../shared/messages";

interface YantuVsCodeApi { postMessage: (message: WebviewMessage) => void; }
declare const acquireVsCodeApi: (() => YantuVsCodeApi) | undefined;

export const hasVscodeApi = typeof acquireVsCodeApi !== "undefined";

const noopVscode = {
  postMessage: (_message: WebviewMessage) => {},
};

const jetBrainsHost = (window as Window & { yantuHost?: YantuVsCodeApi }).yantuHost;

export const vscode = jetBrainsHost ?? (hasVscodeApi ? acquireVsCodeApi!() : noopVscode);
