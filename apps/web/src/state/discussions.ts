import { createDiscussionState } from "@t3tools/client-runtime/state/discussions";
import { connectionAtomRuntime } from "../connection/runtime";

export const discussionEnvironment = createDiscussionState(connectionAtomRuntime);
