import type { ModelSettingsReply, ModelSettingsView, OpenRouterModel, OpenRouterModelView } from '../../../contract/settings.ts';
import type { Controller } from './api.ts';

/** Unsaved App Settings edits, held only in this app session until saved or discarded. */
export interface SettingsDraft { model: string; apiKey: string; escalationModel: string }
/**
 * Why a model Select preselects a model the controller does not use: its saved model left the catalog (`unavailable`),
 * or none is saved (`unsaved`), as for the Model while the controller has none configured. null while it shows the saved
 * model, or before the settings are read.
 */
export type SavedModelState = 'unavailable' | 'unsaved' | null;
export interface SettingsSnapshot {
  capabilities: ModelSettingsView | null; models: OpenRouterModel[]; draft: SettingsDraft | null;
  savedModel: string; serverModel: string; savedEscalation: string; serverEscalation: string;
  modelState: SavedModelState; escalationState: SavedModelState;
  loading: boolean; modelsLoading: boolean; saving: boolean; saved: boolean;
  readError: string; saveError: string; modelsError: string;
}
const message = (failure: unknown) => failure instanceof Error ? failure.message : 'Could not load App Settings.';

/** One Settings session owns confirmed values, edits and requests even while its page is closed. */
export function createAppSettings({ controller }: { controller: Controller }) {
  let state: SettingsSnapshot = { capabilities: null, models: [], draft: null, savedModel: '', serverModel: '', savedEscalation: '', serverEscalation: '', modelState: null, escalationState: null, loading: true, modelsLoading: false, saving: false, saved: false, readError: '', saveError: '', modelsError: '' };
  let catalog: OpenRouterModelView | null = null, reading: Promise<void> | null = null, saving: Promise<boolean> | null = null, writeRevision = 0;
  const listeners = new Set<() => void>();
  const publish = (fields: Partial<SettingsSnapshot>) => { state = { ...state, ...fields }; listeners.forEach(listener => listener()); };
  const values = (): SettingsDraft => state.draft ?? { model: state.savedModel, escalationModel: state.savedEscalation, apiKey: '' };
  // Defaults are presentation choices until saved. Drafts never become the confirmed baseline through a catalog read.
  function choices(capabilities: ModelSettingsView | null) {
    const serverModel = capabilities?.provider === 'openrouter' ? capabilities.model : '';
    const serverEscalation = capabilities?.provider === 'openrouter' ? capabilities.escalationModel : '';
    const listed = (id: string) => catalog?.models.some(model => model.id === id);
    const savedModel = catalog ? listed(serverModel) ? serverModel : catalog.defaultModel : serverModel;
    const savedEscalation = catalog ? listed(serverEscalation) ? serverEscalation : catalog.defaultEscalationModel || savedModel : serverEscalation;
    // Without the catalog a saved model is not judged unavailable; a model never saved is named so either way. Until a
    // model is configured, such as before a key is saved, the controller reports its built-in default, which no one saved.
    const saved = (server: string): SavedModelState => !capabilities ? null : !server ? 'unsaved' : catalog && !listed(server) ? 'unavailable' : null;
    const modelState: SavedModelState = capabilities && !capabilities.modelConfigured ? 'unsaved' : saved(serverModel);
    return { models: catalog?.models ?? [], savedModel, serverModel, savedEscalation, serverEscalation, modelState, escalationState: saved(serverEscalation) };
  }
  function read(modelsOnly: boolean): Promise<void> {
    // Returning to the page observes its pending write; it must not start a competing read of the old values.
    if (state.saving) return saving?.then(() => {}) ?? Promise.resolve();
    if (reading) return reading;
    const revision = writeRevision;
    publish(modelsOnly ? { modelsLoading: true, modelsError: '' } : { loading: true, readError: '', modelsError: '' });
    reading = (async () => {
      if (modelsOnly) {
        try {
          const next = await controller('/api/settings/models') as OpenRouterModelView;
          if (revision !== writeRevision) return;
          catalog = next; publish({ ...choices(state.capabilities), modelsError: '' });
        } catch (failure) { if (revision === writeRevision) publish({ modelsError: message(failure) }); }
        return;
      }
      const [settings, models] = await Promise.allSettled([controller('/api/settings/model') as Promise<ModelSettingsReply>, controller('/api/settings/models') as Promise<OpenRouterModelView>]);
      if (revision !== writeRevision) return;
      const capabilities = settings.status === 'fulfilled' ? settings.value.capabilities : null;
      catalog = models.status === 'fulfilled' ? models.value : null;
      publish({ capabilities, ...choices(capabilities), readError: settings.status === 'rejected' ? message(settings.reason) : '', modelsError: models.status === 'rejected' ? message(models.reason) : '' });
    })().finally(() => { reading = null; publish({ loading: false, modelsLoading: false }); });
    return reading;
  }
  function save(): Promise<boolean> {
    if (saving) return saving;
    const submitted = state.draft, { model, escalationModel, apiKey } = values();
    if (!state.capabilities || !state.models.some(item => item.id === model)) return Promise.resolve(false);
    const validEscalation = state.models.some(item => item.id === escalationModel);
    writeRevision++;
    publish({ saving: true, loading: false, saveError: '', saved: false });
    saving = Promise.resolve().then(async () => {
      try {
        const { capabilities } = await controller('/api/settings/model', { model, ...(validEscalation ? { escalationModel } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }) as ModelSettingsReply;
        const unchanged = state.draft === submitted;
        publish({ capabilities, ...choices(capabilities), draft: unchanged ? null : state.draft, saved: unchanged });
        return true;
      } catch (failure) { publish({ saveError: message(failure) }); return false; }
      finally { saving = null; publish({ saving: false }); }
    });
    return saving;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: () => read(false),
    reloadModels: () => read(true),
    edit(fields: Partial<SettingsDraft>) { publish({ draft: { ...values(), ...fields }, saved: false }); },
    discard() { publish({ draft: null, saved: false, saveError: '' }); },
    save,
  };
}
export type AppSettingsSession = ReturnType<typeof createAppSettings>;
