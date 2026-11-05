#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a standalone agent process, not server code.
// A minimal ACP agent over stdio JSON-RPC: it echoes each prompt back as the agent's reply.
const readline = require("node:readline");
const crypto = require("node:crypto");

/** @param {object} message */
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

/** @param {{ method?: string, params?: any }} message */
const handle = (message) => {
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
        authMethods: [],
        agentInfo: { name: "echo-acp", version: "1" },
      };
    case "session/new":
      return { sessionId: crypto.randomUUID() };
    case "session/prompt": {
      const text = (params.prompt ?? [])
        .filter((/** @type {any} */ block) => block.type === "text")
        .map((/** @type {any} */ block) => block.text)
        .join("\n");
      const request = /<user_request>\n([\s\S]*?)\n<\/user_request>/.exec(text)?.[1] ?? text;
      send({
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Echo: ${request}` },
          },
        },
      });
      return { stopReason: "end_turn" };
    }
    case "authenticate":
    case "session/set_mode":
    case "session/set_model":
    case "session/close":
      return {};
    default:
      throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
  }
};

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  if (message.method === undefined || message.id === undefined || message.id === null) return;
  try {
    send({ id: message.id, result: handle(message) });
  } catch (error) {
    const failure = /** @type {Error & { code?: number }} */ (error);
    send({ id: message.id, error: { code: failure.code ?? -32603, message: failure.message } });
  }
});
