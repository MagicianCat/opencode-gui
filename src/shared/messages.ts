import { z } from "zod/v4";

export const OsTypeSchema = z.enum(["MACOS", "WINDOWS", "LINUX"]);
export type OsType = z.infer<typeof OsTypeSchema>;
export const InstallStatusSchema = z.enum(["project", "global", "update", "missing"]);
export type InstallStatus = z.infer<typeof InstallStatusSchema>;
export const SessionSchema = z.object({ sessionKey: z.string(), title: z.string().optional().default("新对话"), createdAt: z.string().optional(), updatedAt: z.string().optional() }).passthrough();
export type Session = z.infer<typeof SessionSchema>;
export const ChatMessageSchema = z.object({ id: z.string(), role: z.enum(["user", "assistant"]), content: z.string(), runKey: z.string().optional(), createdAt: z.string().optional() });
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export const RecommendationSchema = z.object({ skillKey: z.string(), name: z.string().optional(), description: z.string().optional(), version: z.string().optional(), versionId: z.number().int().positive().optional(), reason: z.string().optional(), detailPath: z.string().optional(), status: InstallStatusSchema.optional().default("missing"), localVersion: z.string().optional() });
export type Recommendation = z.infer<typeof RecommendationSchema>;
export const UpdateScopeSchema = z.enum(["project", "global"]);
export const SkillUpdateSchema = z.object({ skillKey: z.string(), name: z.string().optional(), localVersion: z.string(), latestVersion: z.string(), latestVersionId: z.number().int().positive(), scopes: z.array(UpdateScopeSchema), installing: z.boolean().optional() });
export type SkillUpdate = z.infer<typeof SkillUpdateSchema>;

export const HostMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), authenticated: z.boolean(), loginPending: z.boolean().optional(), userCode: z.string().optional(), osType: OsTypeSchema, sessions: z.array(SessionSchema), currentSessionKey: z.string().optional(), currentRunKey: z.string().optional(), messages: z.array(ChatMessageSchema), recommendations: z.array(RecommendationSchema), confirmationInstalledKeys: z.array(z.string()).default([]), skillUpdates: z.array(SkillUpdateSchema).default([]), updatesChecking: z.boolean().default(false), updatesInstalling: z.boolean().default(false), updateError: z.string().optional(), running: z.boolean(), connection: z.enum(["idle", "connecting", "connected", "reconnecting", "closed"]), error: z.string().optional() }),
  z.object({ type: z.literal("notice"), level: z.enum(["info", "error"]), message: z.string() }),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;
export const WebviewMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }), z.object({ type: z.literal("login") }), z.object({ type: z.literal("logout") }), z.object({ type: z.literal("new-session") }),
  z.object({ type: z.literal("select-session"), sessionKey: z.string() }), z.object({ type: z.literal("delete-session"), sessionKey: z.string() }),
  z.object({ type: z.literal("send-message"), content: z.string().trim().min(1).max(10000) }), z.object({ type: z.literal("cancel-run") }),
  z.object({ type: z.literal("install-skill"), runKey: z.string(), skillKey: z.string() }), z.object({ type: z.literal("install-all"), runKey: z.string() }),
  z.object({ type: z.literal("install-confirmation-skills"), skillKeys: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("open-detail"), detailPath: z.string() }), z.object({ type: z.literal("install-updates"), skillKeys: z.array(z.string()).min(1) }), z.object({ type: z.literal("dismiss-updates") }), z.object({ type: z.literal("retry-updates") }), z.object({ type: z.literal("refresh") }),
]);
export type WebviewMessage = z.infer<typeof WebviewMessageSchema>;
export function parseHostMessage(data: unknown): HostMessage | null { const result = HostMessageSchema.safeParse(data); return result.success ? result.data : null; }
export function parseWebviewMessage(data: unknown): WebviewMessage | null { const result = WebviewMessageSchema.safeParse(data); return result.success ? result.data : null; }
