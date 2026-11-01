/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    const {
      Effect,
      Schema,
      Stream,
      ProviderAdapterV2,
      TextGenerationError,
      buildServerProvider,
      defaultProviderContinuationIdentity,
      makeManualOnlyProviderMaintenanceCapabilities,
      withInstanceIdentity,
    } = api.providers.runtime;
    const driverKind = /** @type {never} */ ("echoAgent");
    /** @param {string} operation */
    const noText = (operation) =>
      Effect.fail(new TextGenerationError({ operation, detail: "Echo writes no text for T3." }));
    // Only registration and the instance's status are exercised; a real driver opens sessions.
    const noSessions = () => Effect.die(new Error("The echo fixture has no sessions."));

    return api.providers.registerDriver({
      driverKind,
      metadata: { displayName: "Echo agent" },
      configSchema: Schema.Struct({ greeting: Schema.optional(Schema.String) }),
      client: {
        settingsSchema: {
          type: "object",
          properties: { greeting: { type: "string", title: "Greeting" } },
        },
        iconUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
      },
      defaultConfig: () => ({}),
      create: ({ instanceId, displayName, accentColor, enabled }) =>
        Effect.sync(() => {
          const continuationIdentity = defaultProviderContinuationIdentity({
            driverKind,
            instanceId,
          });
          const snapshot = withInstanceIdentity({
            instanceId,
            driverKind,
            displayName,
            accentColor,
            continuationGroupKey: continuationIdentity.continuationKey,
          })(
            buildServerProvider({
              presentation: { displayName: "Echo agent" },
              enabled,
              checkedAt: "1970-01-01T00:00:00.000Z",
              models: [],
              probe: {
                installed: true,
                version: "1.0.0",
                status: "ready",
                auth: { status: "authenticated" },
              },
            }),
          );
          const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
            provider: driverKind,
            packageName: null,
          });
          return {
            instanceId,
            driverKind,
            continuationIdentity,
            displayName,
            enabled,
            snapshot: {
              resolveMaintenance: () => Effect.succeed(maintenance),
              getSnapshot: Effect.succeed(snapshot),
              refresh: Effect.succeed(snapshot),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: ProviderAdapterV2.of({
              instanceId,
              driver: driverKind,
              getCapabilities: noSessions,
              planSelectionTransition: noSessions,
              openSession: noSessions,
            }),
            textGeneration: {
              generateCommitMessage: () => noText("generateCommitMessage"),
              generatePrContent: () => noText("generatePrContent"),
              generateBranchName: () => noText("generateBranchName"),
              generateThreadTitle: () => noText("generateThreadTitle"),
              generateReviewGuide: () => noText("generateReviewGuide"),
            },
          };
        }),
    });
  },
};
