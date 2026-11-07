import type { PluginId } from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { parseSkillFrontmatter } from "../provider/Drivers/ClaudeSkills.ts";
import type { DiscoveredPlugin } from "./pluginDiscovery.ts";
import * as PluginHooks from "./PluginHooks.ts";

const encodeClaudePluginManifest = Schema.encodeEffect(
  fromJsonStringPretty(Schema.Struct({ name: Schema.String, description: Schema.String })),
);

/**
 * Builds what gives agents the skills of active plugins. Claude loads a plugin folder whole, with
 * its commands, agents, hooks and MCP servers, so agents get a generated
 * `<stateDir>/plugin-agents/<id>` folder holding only the plugin's skills. Copied, not linked:
 * linking a folder needs extra rights on Windows.
 */
export const makePluginAgentFolders = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hooks = yield* PluginHooks.PluginHooks;

  const agentFoldersRoot = path.join(config.stateDir, "plugin-agents");
  const agentFolderOf = (pluginId: PluginId) => path.join(agentFoldersRoot, pluginId);

  // Read when plugins change, so provider lists name each skill without reading files.
  const skillsIn = (plugin: DiscoveredPlugin, skillsDir: string) =>
    fs.readDirectory(skillsDir).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.flatMap((folders) =>
        Effect.forEach(folders.toSorted(), (folder) => {
          const skillPath = path.join(skillsDir, folder, "SKILL.md");
          return fs.readFileString(skillPath).pipe(
            Effect.map((contents): ReadonlyArray<PluginHooks.PluginSkill> => {
              const frontmatter = parseSkillFrontmatter(contents);
              // Agents cannot load a skill they cannot parse, and agent-only skills stay unlisted.
              if (
                frontmatter.kind === "malformed" ||
                (frontmatter.kind === "parsed" && frontmatter.userInvocable === false)
              ) {
                return [];
              }
              return [
                {
                  pluginId: plugin.id,
                  pluginName: "manifest" in plugin ? plugin.manifest.name : plugin.id,
                  folder,
                  path: skillPath,
                  ...(frontmatter.kind === "parsed" && frontmatter.name !== undefined
                    ? { name: frontmatter.name }
                    : {}),
                  ...(frontmatter.kind === "parsed" && frontmatter.description !== undefined
                    ? { description: frontmatter.description }
                    : {}),
                },
              ];
            }),
            Effect.orElseSucceed((): ReadonlyArray<PluginHooks.PluginSkill> => []),
          );
        }),
      ),
      Effect.map((lists) => lists.flat()),
    );

  const remove = (pluginId: PluginId) =>
    fs.remove(agentFolderOf(pluginId), { recursive: true, force: true }).pipe(Effect.ignore);

  /** Writes the plugin's folder from its `skills/`, or leaves none when it has no skills. */
  const prepare = Effect.fn("PluginHost.prepareAgentFolder")(
    function* (plugin: DiscoveredPlugin, name: string) {
      yield* remove(plugin.id);
      const skills = path.join(plugin.rootDir, "skills");
      if (!(yield* fs.exists(skills))) return;
      const target = agentFolderOf(plugin.id);
      yield* fs.makeDirectory(path.join(target, ".claude-plugin"), { recursive: true });
      const manifest = yield* encodeClaudePluginManifest({
        name: plugin.id,
        description: `Skills from the T3 Code plugin ${name}.`,
      });
      yield* fs.writeFileString(
        path.join(target, ".claude-plugin", "plugin.json"),
        `${manifest}\n`,
      );
      yield* fs.copy(skills, path.join(target, "skills"));
    },
    (effect, plugin) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not prepare a plugin's skills for agents", {
            pluginId: plugin.id,
            cause: Cause.pretty(cause).slice(0, 500),
          }).pipe(Effect.andThen(remove(plugin.id))),
        ),
      ),
  );

  /**
   * Hands agents the folders and skills of `active` plugins. Untraced: it runs in every publish of
   * the plugin list, which has no span of its own.
   */
  const publish = Effect.fnUntraced(function* (active: ReadonlyArray<DiscoveredPlugin>) {
    const withSkills = yield* Effect.filter(
      active.map((plugin) => {
        const folder = agentFolderOf(plugin.id);
        return { plugin, folder: { plugin: folder, skills: path.join(folder, "skills") } };
      }),
      ({ folder }) => fs.exists(folder.skills).pipe(Effect.orElseSucceed(() => false)),
    );
    yield* hooks.setSkillFolders(
      withSkills.map(({ folder }) => folder),
      (yield* Effect.forEach(withSkills, ({ plugin, folder }) =>
        skillsIn(plugin, folder.skills),
      )).flat(),
    );
  });

  return {
    /** Removes every plugin's folder, such as the ones the last run left. */
    removeAll: fs.remove(agentFoldersRoot, { recursive: true, force: true }).pipe(Effect.ignore),
    prepare,
    remove,
    publish,
  };
});
