// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { HOST_ATOM_REACT_EXPORTS, HOST_UI_EXPORTS } from "./web.ts";

const HOST_PREFIX = "\0t3-plugin-host:";

/** Imports that T3 provides at runtime, mapped to their key on `globalThis.__t3PluginHost`. */
const HOST_MODULES: Readonly<Record<string, string>> = {
  react: "react",
  "react-dom": "reactDom",
  "react/jsx-runtime": "jsxRuntime",
  "@effect/atom-react": "atomReact",
  "@t3tools/plugin-sdk/ui": "ui",
};

const FIXED_EXPORTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "@effect/atom-react": HOST_ATOM_REACT_EXPORTS,
  "@t3tools/plugin-sdk/ui": HOST_UI_EXPORTS,
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export interface T3PluginWebOptions {
  /** The web entry, relative to the Vite root. Defaults to `web.tsx`. */
  readonly entry?: string;
  /** Where `web.js` is written, relative to the Vite root. Defaults to `dist`. */
  readonly outDir?: string;
}

/**
 * Builds a plugin's web half as the single-file ESM bundle T3 loads. React, react-dom, the JSX
 * runtime, `@effect/atom-react` and `@t3tools/plugin-sdk/ui` become reads from
 * `globalThis.__t3PluginHost`, so the bundle uses T3's copies instead of shipping its own.
 * Point the manifest's `web` at `<outDir>/web.js`.
 */
export function t3PluginWeb(options: T3PluginWebOptions = {}) {
  let root = NodePath.resolve();
  return {
    name: "t3-plugin-web",
    enforce: "pre" as const,
    config: () => ({
      // The host shares only the production JSX runtime, so development builds must not use jsxDEV.
      oxc: { jsx: { runtime: "automatic" as const, importSource: "react", development: false } },
      build: {
        lib: {
          entry: options.entry ?? "web.tsx",
          formats: ["es" as const],
          fileName: () => "web.js",
        },
        outDir: options.outDir ?? "dist",
      },
    }),
    configResolved: (config: { readonly root: string }) => {
      root = config.root;
    },
    resolveId: (source: string) => (source in HOST_MODULES ? HOST_PREFIX + source : undefined),
    load: (id: string) => {
      if (!id.startsWith(HOST_PREFIX)) return undefined;
      const specifier = id.slice(HOST_PREFIX.length);
      // React's export list depends on its version, so read it from the plugin's own install.
      const names =
        FIXED_EXPORTS[specifier] ??
        Object.keys(NodeModule.createRequire(NodePath.join(root, "package.json"))(specifier));
      const exported = names.filter((name) => name !== "default" && IDENTIFIER.test(name));
      // Pure reads let the bundler drop every export the plugin does not use.
      return [
        `const host = globalThis.__t3PluginHost.${HOST_MODULES[specifier]};`,
        "const read = (name) => host[name];",
        "export default host;",
        ...exported.map(
          (name) => `export const ${name} = /* @__PURE__ */ read(${JSON.stringify(name)});`,
        ),
      ].join("\n");
    },
  };
}
