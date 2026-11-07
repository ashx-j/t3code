import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId, type ServerProvider } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as PluginHooks from "./PluginHooks.ts";
import * as PluginHost from "./PluginHost.ts";
import {
  fixturesDir,
  layerConfig,
  layerFileSystemWith,
  layerHost,
  stateOf,
  waitForStatuses,
  writeFile,
  writeInstalledPlugin,
  writePluginsConfig,
} from "./pluginHostTestHarness.ts";

it.layer(NodeServices.layer)("PluginAgentFolders", (it) => {
  it.effect("gives agents a plugin's skills and instructions until it is disabled", () =>
    Effect.gen(function* () {
      const skills = PluginId.make("skills-plugin");
      const rootDir = `${fixturesDir}skills-plugin`;
      yield* writePluginsConfig({ enabled: { [skills]: true }, devPaths: [rootDir] });
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const hooks = yield* PluginHooks.PluginHooks;
        yield* waitForStatuses(host, { [skills]: "active" });
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        // Claude loads a whole folder as a plugin, so it gets one holding only the skills.
        const agentFolder = `${stateDir}/plugin-agents/skills-plugin`;
        assert.deepStrictEqual(yield* hooks.agentContext, {
          instructions: [
            {
              pluginId: skills,
              text: '<t3_code_plugin name="Release helper">\nWrite release notes in the past tense.\n</t3_code_plugin>',
            },
          ],
          skillFolders: [{ plugin: agentFolder, skills: `${agentFolder}/skills` }],
        });
        // In plugin id order, so a new Claude process gets the same text whatever the start order.
        const removeEarlier = yield* hooks.addAgentInstructions("aaa-plugin", "Earlier.");
        assert.strictEqual((yield* hooks.agentContext)?.instructions[0]?.text, "Earlier.");
        yield* removeEarlier;
        assert.deepStrictEqual((yield* fs.readDirectory(agentFolder)).toSorted(), [
          ".claude-plugin",
          "skills",
        ]);
        assert.include(
          JSON.parse(yield* fs.readFileString(`${agentFolder}/.claude-plugin/plugin.json`)),
          { name: "skills-plugin" },
        );
        assert.isTrue(yield* fs.exists(`${agentFolder}/skills/release-notes/SKILL.md`));

        // The `$` picker lists the skill for the providers that receive it, by each one's name.
        // A provider's own skill of that name stays.
        const ownSkill = {
          name: "release-notes",
          path: "/home/user/.codex/skills/release-notes",
          enabled: true,
        };
        const listed = PluginHooks.withPluginSkills(
          [
            {
              driver: "claudeAgent",
              skills: [],
              workspaceSnapshots: [{ cwd: "/repo", skills: [] }],
            },
            { driver: "codex", skills: [] },
            { driver: "cursor", skills: [] },
            { driver: "codex", skills: [ownSkill] },
          ] as unknown as ReadonlyArray<ServerProvider>,
          yield* hooks.currentSkills,
        );
        const skill = {
          path: `${agentFolder}/skills/release-notes/SKILL.md`,
          enabled: true,
          scope: "plugin",
          displayName: "Release helper: release-notes",
          description: "Drafts release notes from the commits since the last tag.",
        };
        const claudeSkill = { name: "skills-plugin:release-notes", ...skill };
        assert.deepStrictEqual(
          listed.map((provider) => provider.skills),
          [[claudeSkill], [{ name: "release-notes", ...skill }], [], [ownSkill]],
        );
        assert.deepStrictEqual(listed[0]?.workspaceSnapshots?.[0]?.skills, [claudeSkill]);

        // A rescan that finds nothing new publishes nothing, so provider lists are not rebuilt.
        const skillLists = yield* hooks.skills.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* host.rescan;
        // Neither does a change elsewhere on the plugin's row.
        const revision = stateOf(yield* host.list, skills)?.revision;
        assert.isDefined(revision);
        yield* host.reportWebFailure({ pluginId: skills, revision, message: "load threw" });
        yield* host.setEnabled(skills, false);
        assert.deepStrictEqual(
          (yield* Fiber.join(skillLists)).map((list) => list.length),
          [1, 0],
        );
        assert.isUndefined(yield* hooks.agentContext);
        assert.deepStrictEqual(yield* hooks.currentSkills, []);
        assert.isFalse(yield* fs.exists(agentFolder));
      }).pipe(Effect.provide(layerHost()));
    }).pipe(Effect.provide(layerConfig())),
  );

  it.effect("tears down a plugin turned off while its skills are copied for agents", () =>
    Effect.gen(function* () {
      const id = PluginId.make("held");
      const rootDir = yield* writeInstalledPlugin(
        id,
        `module.exports = { activate(api) { api.slashCommands.register({ name: "held" }, () => undefined); } };`,
      );
      yield* writeFile(`${rootDir}/skills/notes/SKILL.md`, "---\nname: notes\n---\nTake notes.\n");
      yield* writePluginsConfig({ enabled: { [id]: true } });
      const copying = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      // Holds the skills copy until the disable has saved plugins.json (its temporary folder is
      // removed last). The release is scheduled, so the disable asks the activation to stop first.
      const layerHeldCopy = layerFileSystemWith((fs) => ({
        copy: (from, to, options) =>
          (from.endsWith("skills")
            ? Deferred.succeed(copying, undefined).pipe(Effect.andThen(Deferred.await(released)))
            : Effect.void
          ).pipe(Effect.andThen(fs.copy(from, to, options))),
        remove: (target, options) =>
          fs
            .remove(target, options)
            .pipe(
              Effect.tap(() =>
                target.includes("plugins.json.")
                  ? Effect.forkDetach(Deferred.succeed(released, undefined))
                  : Effect.void,
              ),
            ),
      }));
      yield* Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const hooks = yield* PluginHooks.PluginHooks;
        yield* Deferred.await(copying);

        yield* host.setEnabled(id, false);
        assert.deepStrictEqual(yield* hooks.currentSlashCommands, []);
        assert.include(yield* host.setEnabled(id, true), { status: "active" });
      }).pipe(Effect.provide(layerHost().pipe(Layer.provide(layerHeldCopy))));
    }).pipe(Effect.provide(layerConfig())),
  );
});
