declare const __YANTU_API_BASE_URL__: string;
declare const __YANTU_WEB_BASE_URL__: string;

export interface BuildConfig {
  apiBaseUrl: string;
  webBaseUrl: string;
}

export const buildConfig: BuildConfig = {
  apiBaseUrl: typeof __YANTU_API_BASE_URL__ === "string" ? __YANTU_API_BASE_URL__ : "http://127.0.0.1:8090/api/v1",
  webBaseUrl: typeof __YANTU_WEB_BASE_URL__ === "string" ? __YANTU_WEB_BASE_URL__ : "http://127.0.0.1:5173",
};
