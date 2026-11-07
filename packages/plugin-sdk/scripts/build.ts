// @effect-diagnostics nodeBuiltinImport:off
// Builds the publishable package into dist: JavaScript from src, declarations that inline every
// type they use from T3's unpublished workspace packages, and a package.json whose exports point
// at them. Publish or pack dist itself, never this folder, whose manifest exports the sources.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { build } from "vite-plus/pack";

const packageRoot = NodePath.resolve(import.meta.dirname, "..");
const repoRoot = NodePath.resolve(packageRoot, "../..");
const outDir = NodePath.join(packageRoot, "dist");
const entries = ["atom", "providers", "server", "shared", "ui", "vite", "web"];
// What the published declarations may import; everything else must be inlined.
const PEER_IMPORT = /^(effect|react)(\/|$)/;
const tsc = NodePath.join(repoRoot, "node_modules/.bin/tsc");

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  readonly repository?: object;
  readonly exports?: Readonly<Record<string, string | { readonly types: string }>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: object;
}
const readManifest = (file: string): PackageManifest =>
  JSON.parse(NodeFS.readFileSync(file, "utf8"));

NodeFS.rmSync(outDir, { recursive: true, force: true });
await build({
  cwd: packageRoot,
  config: false,
  logLevel: "warn",
  entry: Object.fromEntries(entries.map((name) => [name, `src/${name}.ts`])),
  outDir,
  platform: "node",
  fixedExtension: false,
  dts: false,
});

// The compiler writes declarations only for this package's own files and the folders the build
// tsconfig lists. It refuses a few of contracts' largest schemas (TS7056); none of them is used.
const declarations = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-plugin-sdk-types-"));
try {
  const emitted = NodeChildProcess.spawnSync(
    tsc,
    ["-p", "tsconfig.build.json", "--outDir", declarations, "--noCheck"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const errors = emitted.stdout.split("\n").filter((line) => / error TS(?!7056)/.test(line));
  if (emitted.error !== undefined || errors.length > 0) {
    throw new Error(`Writing declarations failed:\n${errors.join("\n") || emitted.error}`);
  }

  const declarationOf = (file: string) =>
    NodePath.join(declarations, NodePath.relative(repoRoot, file)).replace(/\.tsx?$/, ".d.ts");
  // `@t3tools/<package>/<subpath>` to the declaration of the source file its exports name.
  const workspaceDeclaration = (specifier: string) => {
    const [, name, subpath = ""] = /^@t3tools\/([^/]+)(\/.*)?$/.exec(specifier) ?? [];
    if (name === undefined) return undefined;
    const root = NodePath.join(repoRoot, "packages", name);
    const target = readManifest(NodePath.join(root, "package.json")).exports?.[`.${subpath}`];
    const source = typeof target === "string" ? target : target?.types;
    if (source === undefined) throw new Error(`${specifier} names no workspace file.`);
    return declarationOf(NodePath.join(root, source));
  };
  const MISSING = "\0missing-declaration:";

  await build({
    cwd: packageRoot,
    config: false,
    logLevel: "warn",
    entry: Object.fromEntries(
      entries.map((name) => [name, declarationOf(NodePath.join(packageRoot, "src", `${name}.ts`))]),
    ),
    outDir,
    clean: false,
    fixedExtension: false,
    hash: false,
    dts: { dtsInput: true },
    deps: { alwaysBundle: [/^@t3tools\//], neverBundle: PEER_IMPORT },
    // Imports from a refused declaration resolve to nothing; the check below fails if one is used.
    inputOptions: {
      shimMissingExports: true,
      checks: { pluginTimings: false },
      onLog: (level, log, handler) => {
        if (log.code !== "SHIMMED_EXPORT") handler(level, log);
      },
    },
    outputOptions: { chunkFileNames: "chunks/[name].d.ts" },
    plugins: [
      {
        name: "t3-workspace-declarations",
        resolveId(source: string, importer: string | undefined) {
          if (importer === undefined) return undefined;
          if (source.startsWith("@t3tools/")) return workspaceDeclaration(source);
          if (!source.startsWith(".") || !/\.tsx?$/.test(source)) return undefined;
          const file = NodePath.resolve(NodePath.dirname(importer), source).replace(
            /\.tsx?$/,
            ".d.ts",
          );
          return NodeFS.existsSync(file) ? file : MISSING + file;
        },
        load: (id: string) => (id.startsWith(MISSING) ? "export {};" : undefined),
      },
    ],
  });
} finally {
  NodeFS.rmSync(declarations, { recursive: true, force: true });
}

// The published declarations must import nothing but each other and peer dependencies, and must
// typecheck on their own.
const declarationFiles = NodeFS.readdirSync(outDir).filter((file) => file.endsWith(".d.ts"));
for (const file of declarationFiles) {
  const text = NodeFS.readFileSync(NodePath.join(outDir, file), "utf8");
  for (const [, specifier = ""] of text.matchAll(/(?:from|import\()\s*"([^"]+)"/g)) {
    if (!specifier.startsWith("./") && !PEER_IMPORT.test(specifier)) {
      throw new Error(
        `dist/${file} imports ${specifier}, which the published package can't reach.`,
      );
    }
  }
}
const checked = NodeChildProcess.spawnSync(
  tsc,
  [
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "false",
    "--module",
    "nodenext",
    "--target",
    "es2023",
    "--lib",
    "esnext,dom",
    // Source control types name Node's `NodeJS.ProcessEnv`.
    "--types",
    "node",
    ...declarationFiles.map((file) => NodePath.join(outDir, file)),
  ],
  { cwd: packageRoot, encoding: "utf8" },
);
if (checked.status !== 0)
  throw new Error(`The published declarations don't typecheck:\n${checked.stdout}`);

// The source manifest, private and exporting src, becomes one that exports dist. `catalog:` ranges
// become the version this checkout builds with, the one T3 Code runs.
const sources = readManifest(NodePath.join(packageRoot, "package.json"));
const require = NodeModule.createRequire(NodePath.join(packageRoot, "package.json"));
const published = {
  name: sources.name,
  version: sources.version,
  description: sources.description,
  license: sources.license,
  repository: sources.repository,
  type: "module",
  files: ["*.js", "*.d.ts", "chunks"],
  exports: Object.fromEntries(
    Object.entries(sources.exports ?? {}).map(([subpath, target]) => {
      const name = NodePath.basename(typeof target === "string" ? target : target.types, ".ts");
      return [subpath, { types: `./${name}.d.ts`, default: `./${name}.js` }];
    }),
  ),
  peerDependencies: Object.fromEntries(
    Object.entries(sources.peerDependencies ?? {}).map(([name, range]) => [
      name,
      range === "catalog:" ? readManifest(require.resolve(`${name}/package.json`)).version : range,
    ]),
  ),
  peerDependenciesMeta: sources.peerDependenciesMeta,
};
NodeFS.writeFileSync(
  NodePath.join(outDir, "package.json"),
  `${JSON.stringify(published, null, 2)}\n`,
);
NodeFS.copyFileSync(NodePath.join(packageRoot, "README.md"), NodePath.join(outDir, "README.md"));
NodeFS.copyFileSync(NodePath.join(repoRoot, "LICENSE"), NodePath.join(outDir, "LICENSE"));
