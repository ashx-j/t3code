/** What a web plugin's `activate` receives. */
export interface WebPluginApi {
  readonly version: 1;
  readonly id: string;
}

export interface WebPluginDefinition {
  readonly activate: (api: WebPluginApi) => void | Promise<void>;
}

/** Types a web plugin. The ESM bundle's default export is the result. */
export const defineWebPlugin = (definition: WebPluginDefinition): WebPluginDefinition => definition;
