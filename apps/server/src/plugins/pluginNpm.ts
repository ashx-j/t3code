// @effect-diagnostics nodeBuiltinImport:off - npm integrity is a sha512 digest of the raw tarball.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { type TarballFile, unpackNpmTarball } from "./pluginTarball.ts";

const REGISTRY = "https://registry.npmjs.org";
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;

export class PluginNpmError extends Schema.TaggedError<PluginNpmError>()("PluginNpmError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const PackageDocument = Schema.Struct({
  "dist-tags": Schema.optional(Schema.Record(Schema.String, Schema.String)),
  versions: Schema.Record(
    Schema.String,
    Schema.Struct({
      dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.optional(Schema.String) }),
    }),
  ),
});
const decodePackageDocument = Schema.decodeUnknownEffect(PackageDocument);

const failed = (reason: string) => (cause: unknown) => new PluginNpmError({ reason, cause });

/**
 * Downloads `name@version` (the `latest` tag when no version is given) from the npm registry,
 * checks the tarball against the registry's sha512 integrity, and returns its files.
 */
export const fetchNpmPackage = Effect.fn("PluginNpm.fetch")(function* (
  name: string,
  version: string | undefined,
) {
  const http = yield* HttpClient.HttpClient;
  // Scoped names keep their `@`; only the slash is encoded, as the registry expects.
  const metadataUrl = `${REGISTRY}/${name.replace("/", "%2F")}`;
  const document = yield* http.execute(HttpClientRequest.get(metadataUrl)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodePackageDocument),
    Effect.mapError(failed(`Could not read ${name} from the npm registry.`)),
  );
  const wanted = version ?? document["dist-tags"]?.latest;
  const release = wanted === undefined ? undefined : document.versions[wanted];
  if (wanted === undefined || release === undefined) {
    return yield* new PluginNpmError({ reason: `${name}@${version ?? "latest"} does not exist.` });
  }
  const integrity = release.dist.integrity;
  if (integrity?.startsWith("sha512-") !== true) {
    return yield* new PluginNpmError({
      reason: `${name}@${wanted} has no sha512 integrity hash to check it against.`,
    });
  }
  const tarball = yield* http.execute(HttpClientRequest.get(release.dist.tarball)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(failed(`Could not download ${name}@${wanted}.`)),
  );
  if (tarball.byteLength > MAX_TARBALL_BYTES) {
    return yield* new PluginNpmError({ reason: `${name}@${wanted} is larger than 32 MiB.` });
  }
  const digest = NodeCrypto.createHash("sha512").update(tarball).digest("base64");
  if (`sha512-${digest}` !== integrity) {
    return yield* new PluginNpmError({
      reason: `${name}@${wanted} does not match the registry's integrity hash.`,
    });
  }
  return yield* Effect.try({
    try: (): ReadonlyArray<TarballFile> => unpackNpmTarball(tarball),
    catch: (cause) =>
      new PluginNpmError({
        reason: cause instanceof Error ? cause.message : `Could not unpack ${name}@${wanted}.`,
        cause,
      }),
  });
});
