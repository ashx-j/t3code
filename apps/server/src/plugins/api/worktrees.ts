import { ProjectId } from "@t3tools/contracts";
import type { PluginApi } from "@t3tools/plugin-sdk/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ProjectService from "../../project/ProjectService.ts";
import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import type { FacadeContext } from "./facade.ts";
import { PluginProjectNotFoundError } from "./threads.ts";

const decodeProjectId = Schema.decodeUnknownEffect(ProjectId);

export const makeWorktreesApi = (
  facade: FacadeContext,
  services: {
    readonly projectService: ProjectService.ProjectService["Service"];
    readonly git: GitVcsDriver.GitVcsDriver["Service"];
  },
): PluginApi["worktrees"] => ({
  list: (projectId) =>
    facade.call(
      Effect.gen(function* () {
        const project = yield* services.projectService.getById(yield* decodeProjectId(projectId));
        if (Option.isNone(project)) return yield* new PluginProjectNotFoundError({ projectId });
        return yield* services.git.listWorktrees(project.value.workspaceRoot);
      }),
    ),
});
