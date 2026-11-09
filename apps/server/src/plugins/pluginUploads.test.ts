import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PLUGIN_UPLOAD_MAX_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as PluginHost from "./PluginHost.ts";
import {
  fixturesDir,
  layerConfig,
  layerHost,
  listStates,
  waitForStatuses,
} from "./pluginHostTestHarness.ts";
import * as PluginUploads from "./pluginUploads.ts";

/** Posts `files` to `url` through the upload route, over a running plugin host. */
const uploader = Effect.fn(function* () {
  const host = yield* PluginHost.PluginHost;
  yield* waitForStatuses(host, {});
  const app = yield* HttpRouter.toHttpEffect(PluginUploads.layerRoute);
  return (url: string, files: Readonly<Record<string, string | Uint8Array<ArrayBuffer>>>) => {
    const body = new FormData();
    for (const [path, contents] of Object.entries(files)) {
      body.append("file", new Blob([contents]), encodeURIComponent(path));
    }
    const request = new Request(`http://localhost${url}`, { method: "POST", body });
    return app.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.scoped,
      Effect.flatMap((response) =>
        Effect.promise(() => HttpServerResponse.toWeb(response).text()).pipe(
          Effect.map((text) => ({ status: response.status, text })),
        ),
      ),
    );
  };
});

const issueUrl = PluginUploads.PluginUploads.use((uploads) => uploads.issueUrl);

const helloFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return {
    "t3-plugin.json": yield* fs.readFileString(`${fixturesDir}hello-plugin/t3-plugin.json`),
    "server.cjs": yield* fs.readFileString(`${fixturesDir}hello-plugin/server.cjs`),
  };
});

const withHost = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.provide(
      Layer.merge(layerHost(), PluginUploads.layer).pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provideMerge(layerConfig()),
      ),
    ),
  );

it.layer(NodeServices.layer)("PluginUploads", (it) => {
  it.effect("installs an uploaded folder under the paths it was sent with", () =>
    withHost(
      Effect.gen(function* () {
        const upload = yield* uploader();
        const { relativeUrl } = yield* issueUrl;
        const response = yield* upload(relativeUrl, {
          ...(yield* helloFiles),
          "notes/read me.md": "Hello.",
        });
        assert.strictEqual(response.status, 200);
        assert.include(JSON.parse(response.text).plugin, {
          id: "hello-plugin",
          status: "disabled",
        });
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        assert.strictEqual(
          yield* fs.readFileString(`${stateDir}/plugins/hello-plugin/notes/read me.md`),
          "Hello.",
        );
      }),
    ),
  );

  it.effect("installs nothing from a forged, expired or used URL", () =>
    withHost(
      Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const upload = yield* uploader();
        const files = yield* helloFiles;
        const { relativeUrl: expiring } = yield* issueUrl;
        const forged = `${expiring.slice(0, expiring.lastIndexOf(".") + 1)}AAAA`;
        assert.strictEqual((yield* upload(forged, files)).status, 404);
        yield* TestClock.adjust("6 minutes");
        assert.strictEqual((yield* upload(expiring, files)).status, 404);
        assert.deepStrictEqual(yield* listStates(host), []);

        // It installs code, so a URL that leaked after its upload installs nothing more.
        const { relativeUrl } = yield* issueUrl;
        assert.strictEqual((yield* upload(relativeUrl, files)).status, 200);
        assert.strictEqual((yield* upload(relativeUrl, files)).status, 404);
      }),
    ),
  );

  it.effect("refuses a folder over the size limit before installing it", () =>
    withHost(
      Effect.gen(function* () {
        const host = yield* PluginHost.PluginHost;
        const upload = yield* uploader();
        const { relativeUrl } = yield* issueUrl;
        const response = yield* upload(relativeUrl, {
          ...(yield* helloFiles),
          "big.bin": new Uint8Array(PLUGIN_UPLOAD_MAX_BYTES + 1),
        });
        assert.deepStrictEqual(response, {
          status: 413,
          text: "A plugin folder can have up to 1000 files and 25 MB.",
        });
        assert.deepStrictEqual(yield* listStates(host), []);
      }),
    ),
  );
});
