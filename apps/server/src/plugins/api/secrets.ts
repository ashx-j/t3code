import {
  CommandId,
  OrchestratorMcpRequestSecretInput,
  SecretRequestError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { PluginApi } from "@t3tools/plugin-sdk/server";
import type * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type * as SecretRequests from "../../secrets/SecretRequests.ts";
import { abortEffect, type FacadeContext } from "./facade.ts";

const DEFAULT_TIMEOUT = Duration.minutes(10);
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    threadId: ThreadId,
    label: OrchestratorMcpRequestSecretInput.fields.label,
    reason: OrchestratorMcpRequestSecretInput.fields.reason,
    placeholder: OrchestratorMcpRequestSecretInput.fields.placeholder,
    timeoutMs: OrchestratorMcpRequestSecretInput.fields.timeoutMs,
  }),
);

export class PluginSecretRequestNoRunError extends Schema.TaggedError<PluginSecretRequestNoRunError>()(
  "PluginSecretRequestNoRunError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no turn in progress to ask in.`;
  }
}

export const makeSecretsApi = (
  facade: FacadeContext,
  services: {
    readonly threads: ThreadManagementService.ThreadManagementService["Service"];
    readonly secretRequests: SecretRequests.SecretRequests["Service"];
    readonly crypto: Crypto.Crypto;
  },
): PluginApi["secrets"] => ({
  request: ({ signal, ...input }) =>
    facade.call(
      Effect.gen(function* () {
        const request = yield* decodeRequest(input);
        // The card belongs to a run, and the user's answer is refused once that run ends.
        const projection = yield* services.threads.getThreadRecords(request.threadId, ["runs"]);
        const run = ThreadManagementService.latestActiveRun(projection);
        if (run === undefined || run.rootNodeId === null) {
          return yield* new PluginSecretRequestNoRunError({ threadId: request.threadId });
        }
        const id = `plugin:${facade.pluginId}:${yield* services.crypto.randomUUIDv4().pipe(Effect.orDie)}`;
        const turnItemId = TurnItemId.make(`turn-item:secret-request:${id}`);
        const status = yield* services.secretRequests
          .request({
            threadId: request.threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            turnItemId,
            commandId: (secretStatus) => CommandId.make(`command:${id}:secret-${secretStatus}`),
            label: request.label,
            reason: request.reason,
            placeholder: request.placeholder,
            timeout:
              request.timeoutMs === undefined
                ? DEFAULT_TIMEOUT
                : Duration.millis(request.timeoutMs),
          })
          .pipe(
            // Turning the plugin off, or the plugin's own signal, closes the card.
            Effect.raceFirst(
              abortEffect(
                signal === undefined
                  ? facade.activation.controller.signal
                  : AbortSignal.any([signal, facade.activation.controller.signal]),
              ).pipe(Effect.andThen(Effect.interrupt)),
            ),
          );
        if (status !== "saved") return { status };
        const ref = yield* services.secretRequests.savedRef({
          threadId: request.threadId,
          turnItemId,
        });
        if (Option.isNone(ref)) return yield* new SecretRequestError({ reason: "read_failed" });
        // One use: the value leaves the secret store as the plugin receives it.
        const value = yield* services.secretRequests.consume({
          ref: ref.value,
          projectId: projection.thread.projectId,
        });
        return { status, value };
      }),
    ),
});
