/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition} */
module.exports = {
  activate(api) {
    /** @returns {Promise<Array<{ id: string; text: string; at: string }>>} */
    const read = async () => {
      const notes = await api.storage.get("notes");
      return Array.isArray(notes) ? notes : [];
    };
    const save = async (notes) => {
      await api.storage.set("notes", notes);
      api.rpc.publish("notes", notes);
      return notes;
    };
    api.rpc.register("list", read, { access: "read" });
    api.rpc.register(
      "add",
      async (input) => {
        const text = typeof input?.text === "string" ? input.text.trim().slice(0, 500) : "";
        if (text === "") return read();
        const note = { id: Date.now().toString(36), text, at: new Date().toISOString() };
        return save([...(await read()), note].slice(-200));
      },
      { access: "write" },
    );
    api.rpc.register(
      "remove",
      async (input) => save((await read()).filter((note) => note.id !== input?.id)),
      { access: "write" },
    );
  },
};
