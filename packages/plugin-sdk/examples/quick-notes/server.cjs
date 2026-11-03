const { randomUUID } = require("node:crypto");

/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    /** @returns {Promise<Array<{ id: string; text: string; at: string }>>} */
    const read = async () => {
      const notes = await api.storage.get("notes");
      return Array.isArray(notes) ? notes : [];
    };
    // Each change waits for the one before it, so two quick adds never drop a note.
    let changing = Promise.resolve();
    const change = (update) => {
      const changed = changing.then(async () => {
        const notes = update(await read());
        await api.storage.set("notes", notes);
        api.rpc.publish("notes", notes);
        return notes;
      });
      changing = changed.catch(() => undefined);
      return changed;
    };
    api.rpc.register("list", read, { access: "read" });
    api.rpc.register(
      "add",
      async (input) => {
        const text = typeof input?.text === "string" ? input.text.trim().slice(0, 500) : "";
        if (text === "") return read();
        const note = { id: randomUUID(), text, at: new Date().toISOString() };
        return change((notes) => [...notes, note].slice(-200));
      },
      { access: "write" },
    );
    api.rpc.register(
      "remove",
      async (input) => change((notes) => notes.filter((note) => note.id !== input?.id)),
      { access: "write" },
    );
  },
};
