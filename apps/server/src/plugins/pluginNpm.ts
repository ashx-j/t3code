// @effect-diagnostics nodeBuiltinImport:off - npm integrity is a sha512 digest of the raw tarball.
import * as NodeCrypto from "node:crypto";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { type TarballFile, unpackNpmTarball } from "./pluginTarball.ts";

const REGISTRY = "https://registry.npmjs.org";
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
// Install runs in the host's scope where no client can cancel it, so every request has a limit.
const REQUEST_TIMEOUT = Duration.seconds(60);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

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
 * The version `version` names, or the `latest` tag's, and its release from the registry. Untraced:
 * it runs only inside `resolveVersion` and `fetch`, which have their spans.
 */
const readRelease = Effect.fnUntraced(function* (name: string, version: string | undefined) {
  const http = yield* HttpClient.HttpClient;
  // Scoped names keep their `@`; only the slash is encoded, as the registry expects.
  const metadataUrl = `${REGISTRY}/${name.replace("/", "%2F")}`;
  // The abbreviated document lists only what installing needs, a fraction of the full one.
  const metadataRequest = HttpClientRequest.get(metadataUrl).pipe(
    HttpClientRequest.setHeader("accept", "application/vnd.npm.install-v1+json"),
  );
  const document = yield* http.execute(metadataRequest).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodePackageDocument),
    Effect.mapError(failed(`Could not read ${name} from the npm registry.`)),
  );
  const wanted = version ?? document["dist-tags"]?.latest;
  const release = wanted === undefined ? undefined : document.versions[wanted];
  if (wanted === undefined || release === undefined) {
    // Ranges and tags such as ^1.0.0 or next are not resolved, so say what is accepted.
    return yield* new PluginNpmError({
      reason:
        version === undefined || EXACT_VERSION.test(version)
          ? `${name}@${version ?? "latest"} does not exist.`
          : `"${version}" is not an exact version. Use one such as 1.2.3, or leave the version out for the latest.`,
    });
  }
  return { version: wanted, release };
});

/** The version installing `name@version` would fetch now. */
export const resolveNpmVersion = Effect.fn("PluginNpm.resolveVersion")(function* (
  name: string,
  version: string | undefined,
) {
  return (yield* readRelease(name, version)).version;
});

/**
 * Downloads `name@version` (the `latest` tag when no version is given) from the npm registry,
 * checks the tarball against the registry's sha512 integrity, and returns the version and its files.
 */
export const fetchNpmPackage = Effect.fn("PluginNpm.fetch")(function* (
  name: string,
  version: string | undefined,
) {
  const http = yield* HttpClient.HttpClient;
  const { version: wanted, release } = yield* readRelease(name, version);
  const integrity = release.dist.integrity;
  if (integrity?.startsWith("sha512-") !== true) {
    return yield* new PluginNpmError({
      reason: `${name}@${wanted} has no sha512 integrity hash to check it against.`,
    });
  }
  const response = yield* http
    .execute(HttpClientRequest.get(release.dist.tarball))
    .pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(failed(`Could not download ${name}@${wanted}.`)),
    );
  if (Number(response.headers["content-length"] ?? 0) > MAX_TARBALL_BYTES) {
    return yield* new PluginNpmError({ reason: `${name}@${wanted} is larger than 32 MiB.` });
  }
  const tarball = yield* response.arrayBuffer.pipe(
    Effect.timeout(REQUEST_TIMEOUT),
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
  const files = yield* Effect.try({
    try: (): ReadonlyArray<TarballFile> => unpackNpmTarball(tarball),
    catch: (cause) =>
      new PluginNpmError({
        reason: cause instanceof Error ? cause.message : `Could not unpack ${name}@${wanted}.`,
        cause,
      }),
  });
  return { version: wanted, files };
});
