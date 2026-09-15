export interface SettingInspection { defaultValue?: string; globalValue?: string; workspaceValue?: string; workspaceFolderValue?: string; }

export function resolveMachineSetting(inspection: SettingInspection): string {
  return inspection.globalValue ?? inspection.defaultValue ?? "";
}

export function validateServiceBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("平台地址不是有效 URL"); }
  if (url.username || url.password) throw new Error("平台地址不能包含用户名或密码");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("平台地址必须使用 HTTPS；仅本机回环地址允许 HTTP");
  url.hash = "";
  return url;
}
