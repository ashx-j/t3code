import {
  PLUGIN_UPLOAD_MAX_BYTES,
  PLUGIN_UPLOAD_MAX_FILES,
  type PluginCreateUploadUrlResult,
  PluginMutationResult,
  PluginUploadFiles,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse, Multipart } from "effect/http";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PluginInstaller from "./PluginInstaller.ts";

/**
 * A client installs a dropped plugin folder by uploading it here, to a URL `plugins.createUploadUrl`
 * signed. Up to 25 MB as one WebSocket message would hold up every other stream on the socket.
 * The signature is the upload's credential, as for attachments, so the client sends the request
 * the same way on a local, remote or T3 Connect connection. Each URL installs once.
 */
export const PLUGIN_UPLOAD_ROUTE_PREFIX = "/api/plugin-uploads";

const SIGNING_SECRET_NAME = "plugin-upload-signing-key";
// The client uploads as soon as it has the URL.
const UPLOAD_URL_TTL_MS = 5 * 60_000;

const UploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("plugin-upload"),
  expiresAt: Schema.Number,
  // Tells apart URLs signed in the same millisecond, so each one is used up on its own.
  nonce: Schema.String,
});
const uploadClaimsJson = Schema.fromJsonString(UploadClaims);
const encodeUploadClaims = Schema.encodeSync(uploadClaimsJson);
const decodeUploadClaims = Schema.decodeUnknownOption(uploadClaimsJson);
const claimsOf = (payload: string) => {
  try {
    return decodeUploadClaims(base64UrlDecodeUtf8(payload));
  } catch {
    return Option.none();
  }
};
const decodeUploadFiles = Schema.decodeUnknownEffect(PluginUploadFiles);
const mutationResponse = HttpServerResponse.schemaJson(PluginMutationResult);

export class PluginUploadUrlError extends Schema.TaggedError<PluginUploadUrlError>()(
  "PluginUploadUrlError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not sign a plugin upload URL.";
  }
}

export class PluginUploads extends Context.Service<
  PluginUploads,
  {
    /** Signs a URL that installs one uploaded folder within 5 minutes. */
    readonly issueUrl: Effect.Effect<PluginCreateUploadUrlResult, PluginUploadUrlError>;
    /**
     * Whether `token` is a URL this server signed that is unexpired and unused. A valid one is used
     * up, because it installs code.
     */
    readonly claim: (token: string) => Effect.Effect<boolean>;
  }
>()("t3/plugins/pluginUploads") {}

const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const loadSigningSecret = secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  // Unused URLs by nonce, with when each expires. A restart forgets them, which only refuses more.
  const unused = new Map<string, number>();

  const issueUrl = Effect.fn("PluginUploads.issueUrl")(function* () {
    const secret = yield* loadSigningSecret.pipe(
      Effect.mapError((cause) => new PluginUploadUrlError({ cause })),
    );
    const now = yield* Clock.currentTimeMillis;
    for (const [nonce, expiresAt] of unused) if (expiresAt <= now) unused.delete(nonce);
    const expiresAt = now + UPLOAD_URL_TTL_MS;
    const nonce = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError((cause) => new PluginUploadUrlError({ cause })));
    const payload = base64UrlEncode(
      encodeUploadClaims({ version: 1, kind: "plugin-upload", expiresAt, nonce }),
    );
    unused.set(nonce, expiresAt);
    const result: PluginCreateUploadUrlResult = {
      relativeUrl: `${PLUGIN_UPLOAD_ROUTE_PREFIX}/${payload}.${signPayload(payload, secret)}`,
      expiresAt,
    };
    return result;
  });

  const claim = Effect.fn("PluginUploads.claim")(function* (token: string) {
    const [payload, signature, unexpected] = token.split(".");
    if (!payload || !signature || unexpected !== undefined) return false;
    const secret = yield* loadSigningSecret.pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to load the plugin upload signing key.", { cause }),
      ),
      Effect.option,
    );
    if (
      Option.isNone(secret) ||
      !timingSafeEqualBase64Url(signature, signPayload(payload, secret.value))
    ) {
      return false;
    }
    const claims = claimsOf(payload);
    if (Option.isNone(claims) || claims.value.expiresAt <= (yield* Clock.currentTimeMillis)) {
      return false;
    }
    return unused.delete(claims.value.nonce);
  });

  return PluginUploads.of({ issueUrl: issueUrl(), claim });
});

export const layer = Layer.effect(PluginUploads, make);

// The total leaves room for each part's headers, whose file name is a path escaped with
// encodeURIComponent; the schema then checks the exact limits.
const UPLOAD_LIMITS = Multipart.limitsServices({
  maxParts: PLUGIN_UPLOAD_MAX_FILES,
  maxFileSize: PLUGIN_UPLOAD_MAX_BYTES,
  maxTotalSize: PLUGIN_UPLOAD_MAX_BYTES + PLUGIN_UPLOAD_MAX_FILES * 10 * 1024,
  // By default a JSON part is read as a field, which would drop t3-plugin.json.
  fieldMimeTypes: [],
});

const text = (body: string, status: number) => HttpServerResponse.text(body, { status });
const notAnUpload = text("The request is not a plugin folder.", 400);

// A part named with a malformed escape names no file.
const decodePath = (name: string) => {
  try {
    return Option.some(decodeURIComponent(name));
  } catch {
    return Option.none();
  }
};

/** `POST <PLUGIN_UPLOAD_ROUTE_PREFIX>/<token>`: installs the folder like `PluginInstaller.installFiles`. */
export const layerRoute = HttpRouter.add(
  "POST",
  `${PLUGIN_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return text("Bad Request", 400);
    const uploads = yield* PluginUploads;
    // An expired, forged or used URL looks like no route at all.
    if (
      !(yield* uploads.claim(url.value.pathname.slice(`${PLUGIN_UPLOAD_ROUTE_PREFIX}/`.length)))
    ) {
      return text("Not Found", 404);
    }
    // In memory, as `installFiles` takes them.
    const received = yield* request.multipartStream.pipe(
      Stream.filter(Multipart.isFile),
      Stream.mapEffect((file) =>
        file.contentEffect.pipe(
          Effect.map((contents) =>
            Option.map(decodePath(file.name), (path) => ({ path, contents })),
          ),
        ),
      ),
      Stream.runCollect,
      Effect.provideContext(UPLOAD_LIMITS),
      Effect.result,
    );
    if (received._tag === "Failure") {
      return received.failure.reason._tag === "Parse" ||
        received.failure.reason._tag === "InternalError"
        ? notAnUpload
        : text(
            `A plugin folder can have up to ${PLUGIN_UPLOAD_MAX_FILES} files and ${PLUGIN_UPLOAD_MAX_BYTES / 1024 / 1024} MB.`,
            413,
          );
    }
    const named = Option.all(received.success);
    if (Option.isNone(named)) return notAnUpload;
    const files = yield* decodeUploadFiles(named.value).pipe(Effect.result);
    if (files._tag === "Failure") return text(files.failure.message, 400);
    const installer = yield* PluginInstaller.PluginInstaller;
    return yield* installer.installFiles(files.success).pipe(
      Effect.flatMap((plugin) => mutationResponse({ plugin }).pipe(Effect.orDie)),
      Effect.catchTags({
        PluginInstallError: (error) => Effect.succeed(text(error.message, 400)),
        PluginNotFoundError: (error) => Effect.succeed(text(error.message, 404)),
        PluginConfigError: (error) => Effect.succeed(text(error.message, 500)),
      }),
    );
  }),
);
