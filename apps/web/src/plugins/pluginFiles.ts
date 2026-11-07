import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";
import { readPreparedConnection } from "../state/session";

// Bearer and cookie sessions can fetch plugin files directly. A DPoP proof needs the relay
// signer, which only the client runtime holds.
async function pluginFileRequestInit(
  authorization: PreparedHttpAuthorization | null,
  url: URL,
): Promise<RequestInit> {
  if (authorization === null) return { credentials: "include" };
  if (authorization._tag === "Bearer") {
    return { headers: { authorization: `Bearer ${authorization.token}` } };
  }
  const headers = await runAtomCommand(
    appAtomRegistry,
    pluginEnvironment.pluginFileHeaders,
    { authorization, url: url.href },
    { reportFailure: false },
  );
  if (headers._tag !== "Success")
    throw new Error("Could not authorize the request over T3 Connect.");
  return { headers: { ...headers.value } };
}

class PluginFileRequestError extends Error {
  constructor(
    readonly status: number,
    filePath: string,
  ) {
    super(`The request for ${filePath} failed with ${status}.`);
  }
}

// A dropped connection or a gateway error, such as one bad gateway over T3 Connect, can pass.
const isPassingDownloadFailure = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof PluginFileRequestError && [502, 503, 504].includes(error.status));
const DOWNLOAD_RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

/**
 * Fetches a file the plugin's server serves with the connection's credentials. `revision` names
 * the file's contents, so the server lets browsers cache its URL for good.
 */
export async function fetchPluginFile(
  environmentId: EnvironmentId,
  plugin: PluginState,
  filePath: string,
  revision: string,
): Promise<Response> {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The environment is not connected.");
  const authorization = connection.httpAuthorization;
  const url = new URL(
    `/api/plugins/${encodeURIComponent(plugin.id)}${filePath}`,
    connection.httpBaseUrl,
  );
  url.searchParams.set("v", revision);
  const response = await fetch(url, await pluginFileRequestInit(authorization, url));
  if (!response.ok) throw new PluginFileRequestError(response.status, filePath);
  return response;
}

/**
 * Runs `download` again after a failure that can pass, 1, 5 and then 30 seconds later. Resolves
 * undefined when `cancelled` turns true during a wait.
 */
export async function withDownloadRetries<A>(
  download: () => Promise<A>,
  cancelled: () => boolean,
): Promise<A | undefined> {
  for (const delay of [...DOWNLOAD_RETRY_DELAYS_MS, undefined]) {
    try {
      return await download();
    } catch (error) {
      if (delay === undefined || !isPassingDownloadFailure(error)) throw error;
      await new Promise((resume) => setTimeout(resume, delay));
      if (cancelled()) return undefined;
    }
  }
  return undefined;
}
