/** Read-only repository configuration. Values are observations, not editable cloud settings. */
export type ConfigField = { key: string; label: string; readOnly: true } & (
  { type: 'list'; value: string[] } | { type: 'boolean' | 'number' | 'text'; value: string | number | boolean }
);
export interface ConfigSection { id: string; title: string; fields: ConfigField[] }
/** The controller adds an edit link, or marks a branch GitHub does not have. */
export interface ConfigFile { path: string; editUrl?: string; local?: boolean }
export interface ServiceConfiguration { nodeId: string | null; provider: string | null; files: ConfigFile[]; sections: ConfigSection[] }
