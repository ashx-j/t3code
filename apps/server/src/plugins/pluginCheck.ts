import { PluginManifest } from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { secretsOutsideStore, settingsSchemaProblem } from "./PluginSettingsStore.ts";

const MANIFEST_FILE = "t3-plugin.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
// Bounds what one check reads, so a folder full of build output cannot stall the server.
const MAX_SCANNED_BYTES = 10 * 1024 * 1024;
const MAX_CSS_FILES = 20;
const MAX_EXAMPLE_CHARS = 60;
const MAX_REASON_CHARS = 500;
const VITE_PRESET_FIX =
  "Build the web half with t3PluginWeb from @t3tools/plugin-sdk/vite, which reads React and the UI kit from T3 and bundles everything else into one file.";

// Types rather than interfaces, so a report is JSON as MCP tools return it.
export type PluginCheckFinding = {
  /** Stable name of the check, such as `entry-missing`. */
  readonly code: string;
  /** `error` stops the plugin from loading; `warning` is likely to break or look wrong. */
  readonly severity: "error" | "warning";
  /** Relative to the plugin folder. */
  readonly file: string | null;
  readonly problem: string;
  readonly fix: string;
};

export type PluginCheckReport = {
  readonly folder: string;
  /** Null when the manifest does not decode. */
  readonly pluginId: string | null;
  readonly findings: ReadonlyArray<PluginCheckFinding>;
};

/**
 * Patterns in a plugin's web bundle or CSS that tie it to T3's markup or colors, which change
 * between releases. Add a row to catch another one.
 */
const FRAGILE_PATTERNS: ReadonlyArray<{
  readonly code: string;
  readonly pattern: RegExp;
  readonly problem: string;
  readonly fix: string;
}> = [
  {
    code: "aria-label-selector",
    pattern: /\[aria-label/g,
    problem: "selects T3's elements by aria-label",
    fix: "Labels change with wording. Replace the part with ui.replace, or style elements the plugin renders.",
  },
  {
    code: "data-slot-selector",
    pattern: /\[data-slot/g,
    problem: "selects T3's elements by data-slot",
    fix: "Slot names belong to T3's components and change with them. Replace the part with ui.replace, or style elements the plugin renders.",
  },
  {
    code: "has-selector",
    pattern: /:has\(/g,
    problem: "uses :has() to reach into T3's markup",
    fix: "Replace the part with ui.replace instead of matching T3's element structure.",
  },
  {
    code: "class-attribute-selector",
    pattern: /\[class\s*[~*^$|]?=/g,
    problem: "matches T3's elements by their class attribute",
    fix: "T3's utility classes change between releases. Replace the part with ui.replace, or style elements the plugin renders.",
  },
  {
    code: "icon-class-selector",
    pattern: /\.lucide-[a-z]/g,
    problem: "selects T3's icons by their lucide-* class",
    fix: "Icons change when T3 swaps them. Replace the part with ui.replace, or render the plugin's own icon.",
  },
  {
    code: "window-controls",
    pattern: /titlebar-area|window-controls/g,
    problem: "positions content against the title bar or window controls",
    fix: "Window controls differ by platform. Put controls inside a part T3 lays out, so they never sit under the window buttons.",
  },
  {
    code: "fixed-color",
    // A declaration whose value has a literal color. Custom properties (`--name: #fff`) define
    // tokens, so they are skipped.
    pattern:
      /(?<![\w-])[a-zA-Z][\w-]*\s*:\s*["'`]?[^;{}"'`\n]*?(?:#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\()/g,
    problem: "uses fixed colors",
    fix: "Use T3's theme variables, such as var(--foreground) and var(--border), so the plugin follows light, dark and custom themes.",
  },
];

/** Codes of the findings the SDK README's update section explains. */
export const FRAGILE_CODES: ReadonlySet<string> = new Set(FRAGILE_PATTERNS.map(({ code }) => code));

// Every static or dynamic import specifier, minified or not.
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])([^"'\n]+)\1/g;
// React's internals export, which only a bundled copy of React carries.
const BUNDLED_REACT = /__CLIENT_INTERNALS_DO_NOT_USE|__SECRET_INTERNALS_DO_NOT_USE/;

const parseJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeUnknownExit(PluginManifest);

const reasonOf = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).slice(0, MAX_REASON_CHARS);

const exampleAt = (text: string, index: number) =>
  text
    .slice(index, index + MAX_EXAMPLE_CHARS)
    .split("\n", 1)[0]
    ?.trim();

/** Fragile patterns in one file, one finding per pattern with a count and the first match. */
const scanForFragilePatterns = (file: string, text: string): ReadonlyArray<PluginCheckFinding> =>
  FRAGILE_PATTERNS.flatMap(({ code, pattern, problem, fix }): ReadonlyArray<PluginCheckFinding> => {
    const matches = Array.from(text.matchAll(pattern));
    const first = matches[0];
    if (first === undefined) return [];
    const places = matches.length === 1 ? "1 place" : `${matches.length} places`;
    return [
      {
        code,
        severity: "warning",
        file,
        problem: `${file} ${problem} (${places}), for example \`${exampleAt(text, first.index)}\`.`,
        fix,
      },
    ];
  });

/** Signs that a web bundle was not built with the SDK's Vite preset. */
const scanWebBundle = (file: string, text: string): ReadonlyArray<PluginCheckFinding> => {
  const findings: Array<PluginCheckFinding> = [];
  const specifiers = new Set(
    Array.from(text.matchAll(IMPORT_SPECIFIER), (match) => match[2] ?? "").filter(
      (specifier) => specifier !== "" && !/^(?:https?|data|blob):/.test(specifier),
    ),
  );
  if (specifiers.size > 0) {
    findings.push({
      code: "bundle-imports",
      severity: "warning",
      file,
      problem: `${file} imports ${Array.from(specifiers, (specifier) => `"${specifier}"`)
        .slice(0, 5)
        .join(", ")}. T3 loads the bundle alone from a blob: URL, where those imports fail.`,
      fix: VITE_PRESET_FIX,
    });
  }
  if (BUNDLED_REACT.test(text)) {
    findings.push({
      code: "bundled-react",
      severity: "warning",
      file,
      problem: `${file} carries its own copy of React, so hooks in its components fail under T3's React.`,
      fix: VITE_PRESET_FIX,
    });
  }
  if (text.includes("jsxDEV")) {
    findings.push({
      code: "dev-jsx",
      severity: "warning",
      file,
      problem: `${file} uses the development JSX runtime (jsxDEV), which T3 does not share.`,
      fix: VITE_PRESET_FIX,
    });
  }
  return findings;
};

/**
 * Reads a plugin folder the way the host would load it and lists what would stop it loading or
 * break it when T3 updates. It never runs the plugin's code.
 */
export const checkPluginFolder = Effect.fn("PluginCheck.check")(function* (
  folder: string,
  serverVersion: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const findings: Array<PluginCheckFinding> = [];
  const report = (pluginId: string | null = null): PluginCheckReport => ({
    folder,
    pluginId,
    findings,
  });

  const info = yield* fs.stat(folder).pipe(Effect.option);
  if (info._tag === "None" || info.value.type !== "Directory") {
    findings.push({
      code: "folder-missing",
      severity: "error",
      file: null,
      problem: `${folder} is not a folder on the server.`,
      fix: "Pass the folder that holds t3-plugin.json.",
    });
    return report();
  }
  const sizeOf = (file: string) =>
    fs
      .stat(file)
      .pipe(
        Effect.option,
        Effect.map(Option.flatMap((stat) => Option.liftPredicate(stat, (s) => s.type === "File"))),
        Effect.map(Option.map((stat) => Number(stat.size))),
      );
  // A link out of the folder could make the report quote any file on the server.
  const root = yield* fs.realPath(folder).pipe(Effect.orElseSucceed(() => folder));
  const isInside = (file: string) =>
    fs.realPath(file).pipe(
      Effect.map((real) => real.startsWith(`${root}${path.sep}`)),
      Effect.orElseSucceed(() => false),
    );
  // Nothing for a file that is missing, outside the folder or larger than `limit`.
  const readText = (file: string, limit: number) =>
    Effect.all([isInside(file), sizeOf(file)]).pipe(
      Effect.flatMap(([inside, size]) =>
        inside && Option.isSome(size) && size.value <= limit
          ? fs.readFileString(file).pipe(Effect.option)
          : Effect.succeedNone,
      ),
    );

  const manifestPath = path.join(folder, MANIFEST_FILE);
  const raw = yield* readText(manifestPath, MAX_MANIFEST_BYTES);
  if (Option.isNone(raw)) {
    const size = yield* sizeOf(manifestPath);
    findings.push({
      code: "manifest-missing",
      severity: "error",
      file: MANIFEST_FILE,
      problem: Option.isNone(size)
        ? `The folder has no ${MANIFEST_FILE}.`
        : size.value > MAX_MANIFEST_BYTES
          ? `${MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes.`
          : `${MANIFEST_FILE} links to a file outside the plugin folder.`,
      fix: "Add the manifest at the plugin's root; the Manifest section of the plugin SDK README lists its fields.",
    });
    return report();
  }
  const parsed = parseJson(raw.value);
  if (parsed._tag === "Failure") {
    findings.push({
      code: "manifest-invalid",
      severity: "error",
      file: MANIFEST_FILE,
      problem: `${MANIFEST_FILE} is not valid JSON: ${reasonOf(Cause.squash(parsed.cause))}`,
      fix: "Fix the JSON syntax.",
    });
    return report();
  }
  const loose: Readonly<Record<string, unknown>> = Predicate.isObject(parsed.value)
    ? parsed.value
    : {};
  const decoded = decodeManifest(parsed.value);
  if (decoded._tag === "Failure") {
    findings.push({
      code: "manifest-invalid",
      severity: "error",
      file: MANIFEST_FILE,
      problem: `${MANIFEST_FILE} is not a valid manifest: ${reasonOf(Cause.squash(decoded.cause))}`,
      fix: "Fix the fields it names; the Manifest section of the plugin SDK README lists them.",
    });
  } else {
    if (!satisfiesSemverRange(serverVersion, decoded.value.engines.t3)) {
      findings.push({
        code: "engine-range",
        severity: "error",
        file: MANIFEST_FILE,
        problem: `engines.t3 is "${decoded.value.engines.t3}", which leaves out this server's version, ${serverVersion}.`,
        fix: `Widen engines.t3 to include ${serverVersion}, for example ">=${serverVersion.split("-")[0]}".`,
      });
    }
    const settingsProblem =
      decoded.value.settingsSchema === undefined
        ? undefined
        : settingsSchemaProblem(decoded.value.settingsSchema);
    if (settingsProblem?.kind === "unreadable") {
      findings.push({
        code: "settings-schema-unreadable",
        severity: "warning",
        file: MANIFEST_FILE,
        problem: `T3 cannot read settingsSchema, so every settings save fails: ${settingsProblem.reason}`,
        fix: "Use JSON Schema 2020-12 keywords that describe plain JSON values.",
      });
    } else if (settingsProblem?.kind === "default") {
      findings.push({
        code: "settings-default-invalid",
        severity: "warning",
        file: MANIFEST_FILE,
        problem: `A default in settingsSchema breaks its own field, so every settings save fails: ${settingsProblem.reason}`,
        fix: "Change the default, or the rule it breaks, so the two agree.",
      });
    }
    const plainSecrets =
      decoded.value.settingsSchema === undefined
        ? []
        : secretsOutsideStore(decoded.value.settingsSchema);
    if (plainSecrets.length > 0) {
      findings.push({
        code: "secret-not-stored",
        severity: "warning",
        file: MANIFEST_FILE,
        problem: `settingsSchema marks ${plainSecrets.join(", ")} as t3-secret, but only top-level string fields go to the secret store, so the rest are saved as plain text in settings.json.`,
        fix: 'Make each secret a top-level field with "type": "string".',
      });
    }
  }

  // Entry checks read the raw fields, so a manifest that fails to decode still gets them.
  const entry = (key: "server" | "web") => {
    const value = loose[key];
    return typeof value === "string" ? value.trim().replace(/^\.\//, "") : undefined;
  };
  const server = entry("server");
  if (server !== undefined && !server.endsWith(".cjs")) {
    findings.push({
      code: "server-not-cjs",
      severity: "error",
      file: MANIFEST_FILE,
      problem: `The server entry ${server} is not a .cjs file. T3's packaged server can only require() CommonJS.`,
      fix: "Bundle the server half as CommonJS and name it with .cjs, for example dist/server.cjs.",
    });
  }
  const web = entry("web");
  for (const [key, file] of [
    ["server", server],
    ["web", web],
  ] as const) {
    if (file === undefined || Option.isSome(yield* sizeOf(path.join(folder, file)))) continue;
    findings.push({
      code: "entry-missing",
      severity: "error",
      file: MANIFEST_FILE,
      problem: `The ${key} entry ${file} does not exist.`,
      fix: `Build the plugin, or point ${key} at the built file.`,
    });
  }

  if (web !== undefined) {
    const bundle = yield* readText(path.join(folder, web), MAX_SCANNED_BYTES);
    if (Option.isSome(bundle)) {
      findings.push(
        ...scanWebBundle(web, bundle.value),
        ...scanForFragilePatterns(web, bundle.value),
      );
    }
  }
  // CSS beside the manifest and the web bundle, which a plugin passes to injectStyles.
  const webFolder = web?.slice(0, Math.max(0, web.lastIndexOf("/"))) ?? "";
  const cssFiles: Array<string> = [];
  for (const within of new Set(["", webFolder])) {
    const entries = yield* fs
      .readDirectory(path.join(folder, within))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of entries.toSorted()) {
      if (!name.endsWith(".css")) continue;
      const file = within === "" ? name : `${within}/${name}`;
      if (!cssFiles.includes(file)) cssFiles.push(file);
    }
  }
  // Vite's library mode writes an imported stylesheet beside the bundle, and T3 loads only the
  // bundle. The root is left out: hand-written plugins keep source CSS there.
  const emittedCss =
    webFolder === "" ? [] : cssFiles.filter((file) => file.startsWith(`${webFolder}/`));
  if (emittedCss.length > 0) {
    findings.push({
      code: "css-not-loaded",
      severity: "warning",
      file: emittedCss[0] ?? null,
      problem: `${emittedCss.join(", ")} ${emittedCss.length === 1 ? "sits" : "sit"} beside the web bundle, and T3 never loads CSS files.`,
      fix: 'Import the stylesheet with `import css from "./web.css?inline"` and pass it to `api.injectStyles(css)`.',
    });
  }
  for (const file of cssFiles.slice(0, MAX_CSS_FILES)) {
    const css = yield* readText(path.join(folder, file), MAX_SCANNED_BYTES);
    if (Option.isSome(css)) findings.push(...scanForFragilePatterns(file, css.value));
  }

  return report(decoded._tag === "Success" ? decoded.value.id : null);
});
