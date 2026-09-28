export interface SettingInspection { defaultValue?: string; globalValue?: string; workspaceValue?: string; workspaceFolderValue?: string; }
const INTERNAL_HTTP_HOSTS = new Set(["10.154.76.195"]);

export class ServiceUrlValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ServiceUrlValidationError"; }
}

export function resolveMachineSetting(inspection: SettingInspection): string {
  return inspection.globalValue ?? inspection.defaultValue ?? "";
}

export function validateServiceBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ServiceUrlValidationError("平台地址不是有效 URL"); }
  if (url.username || url.password) throw new ServiceUrlValidationError("平台地址不能包含用户名或密码");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const allowedInternalHttp = url.protocol === "http:" && INTERNAL_HTTP_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) && !allowedInternalHttp) throw new ServiceUrlValidationError("平台地址必须使用 HTTPS；仅已授权的内网地址允许 HTTP");
  url.hash = "";
  return url;
}
