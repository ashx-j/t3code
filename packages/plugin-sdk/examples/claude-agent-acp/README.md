# Claude Agent over ACP

A server-only plugin that adds an agent provider. It runs the ACP Registry's Claude Agent package
with `npx`, so the server needs Node.js on its `PATH`, and the agent signs in with your Claude Code
login.

Install it by dragging this folder onto **Settings → Plugins**, or with **Add plugin → Choose folder**, then turn on
**Claude Agent (ACP)** in **Settings → Providers**. To run another ACP agent, change the command
and arguments on its card, or add a second one with **Add provider**.

It uses `api.providers.registerAcpAgent`.
