/** Public model configuration. A key's presence is reported; its value is never returned. */
export interface BrowserModelView {
  provider: 'openrouter' | 'custom'; model: string; baseUrl: string;
  keyConfigured: boolean; modelConfigured: boolean; modelError?: string;
}
/** App-wide settings include the saved escalation model, or an empty string until one is saved. */
export interface ModelSettingsView extends BrowserModelView { escalationModel: string }
/** GET and POST /api/settings/model. Runtime fields may be absent when the runtime cannot report them. */
export interface ModelSettingsReply {
  capabilities: ModelSettingsView & { runtimeInstalled?: boolean; browserInstalled?: boolean; runtimeProject?: string };
}
/** An eligible model listed by OpenRouter's public catalog. */
export interface OpenRouterModel { id: string; name: string; provider: string }
/** GET /api/settings/models. Both defaults name models present in this catalog. */
export interface OpenRouterModelView { models: OpenRouterModel[]; defaultModel: string; defaultEscalationModel: string }
