import { createFileRoute } from "@tanstack/react-router";

import { PluginPage } from "../plugins/PluginPage";

function PluginPageRoute() {
  const { pluginId, name } = Route.useParams();
  return <PluginPage pluginId={pluginId} name={name} />;
}

export const Route = createFileRoute("/_chat/plugins/$pluginId/$name")({
  component: PluginPageRoute,
});
