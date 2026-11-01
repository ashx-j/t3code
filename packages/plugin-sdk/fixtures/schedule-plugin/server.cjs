/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    let runs = 0;
    let cancel = () => {};
    api.rpc.register(
      "remindAt",
      (input) => {
        const { time, weekdays } = /** @type {{ time: string, weekdays?: number[] }} */ (input);
        cancel();
        cancel = api.schedule.at({ time, weekdays }, () => {
          runs += 1;
          api.rpc.publish("reminders", runs);
        });
        return null;
      },
      { access: "write" },
    );
    api.rpc.register(
      "stopReminders",
      () => {
        cancel();
        return runs;
      },
      { access: "write" },
    );
  },
};
