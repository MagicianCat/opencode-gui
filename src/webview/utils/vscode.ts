import type { WebviewMessage } from "../../shared/messages";

interface YantuVsCodeApi { postMessage: (message: WebviewMessage) => void; }
declare const acquireVsCodeApi: (() => YantuVsCodeApi) | undefined;

export const hasVscodeApi = typeof acquireVsCodeApi !== "undefined";

const noopVscode = {
  postMessage: (_message: WebviewMessage) => {},
};

export const vscode = hasVscodeApi ? acquireVsCodeApi!() : noopVscode;
