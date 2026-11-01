/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    const { Effect } = api.providers.runtime;
    const { unknownDefinition, providerAuth } = api.sourceControl.runtime;
    const kind = /** @type {never} */ ("examplegit");
    /** @param {string} operation */
    const none = (operation) => () =>
      Effect.die(new Error(`The Example Git fixture has no ${operation}.`));

    return api.sourceControl.registerDriver({
      kind,
      definition: {
        ...unknownDefinition,
        kind,
        label: "Example Git",
        pickerLabel: "Example Git",
        recognizeRemote: (remote) =>
          remote.host === "git.example.test"
            ? { kind, name: "Example Git", baseUrl: `https://${remote.host}` }
            : null,
      },
      make: Effect.succeed({
        sourceControl: {
          kind,
          listChangeRequests: none("listChangeRequests"),
          getChangeRequest: none("getChangeRequest"),
          createChangeRequest: none("createChangeRequest"),
          getRepositoryCloneUrls: none("getRepositoryCloneUrls"),
          createRepository: none("createRepository"),
          getDefaultBranch: none("getDefaultBranch"),
          checkoutChangeRequest: none("checkoutChangeRequest"),
        },
        discovery: {
          type: "api",
          kind,
          label: "Example Git",
          installHint: "Nothing to install.",
          probeAuth: Effect.succeed(providerAuth({ status: "unknown" })),
        },
        pullRequests: {
          kind,
          capabilities: {
            diff: false,
            comment: false,
            actions: [],
            mergeMethods: [],
            search: false,
            reactions: false,
            review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
            reviewers: { request: false, listCandidates: false },
            edit: { changeRequest: false, comment: false },
          },
          getViewer: () => Effect.succeed("example-bot"),
          getViewerPermissions: none("getViewerPermissions"),
          listChangeRequests: () =>
            Effect.succeed({ items: [], truncated: false, continues: false }),
          getChangeRequest: none("getChangeRequest"),
          getChangeRequestActivity: none("getChangeRequestActivity"),
          getDiff: none("getDiff"),
          runAction: none("runAction"),
          updateChangeRequest: none("updateChangeRequest"),
          comment: none("comment"),
          updateComment: none("updateComment"),
          submitReview: none("submitReview"),
          replyToThread: none("replyToThread"),
          setThreadResolution: none("setThreadResolution"),
          setReaction: none("setReaction"),
          listReviewerCandidates: none("listReviewerCandidates"),
          setReviewerRequest: none("setReviewerRequest"),
        },
      }),
    });
  },
};
