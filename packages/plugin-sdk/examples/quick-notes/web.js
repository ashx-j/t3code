// \0t3-plugin-host:@t3tools/plugin-sdk/ui
var host$2 = globalThis.__t3PluginHost.ui;
var read$2 = (name) => host$2[name];
var Button = /* @__PURE__ */ read$2("Button");
var Input = /* @__PURE__ */ read$2("Input");
// src/web.ts
/** Types a web plugin. The ESM bundle's default export is the result. */
var defineWebPlugin = (definition) => definition;
// \0t3-plugin-host:react
var host$1 = globalThis.__t3PluginHost.react;
var read$1 = (name) => host$1[name];
var useEffect = /* @__PURE__ */ read$1("useEffect");
var useState = /* @__PURE__ */ read$1("useState");
// \0t3-plugin-host:react/jsx-runtime
var host = globalThis.__t3PluginHost.jsxRuntime;
var read = (name) => host[name];
var jsx = /* @__PURE__ */ read("jsx");
var jsxs = /* @__PURE__ */ read("jsxs");
// examples/quick-notes/web.tsx
var css = `
.quick-notes-list { display: flex; flex-direction: column; gap: 0.25rem; }
.quick-notes-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; }
.quick-notes-item span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.quick-notes-sidebar { padding-inline: 0.5rem; font-size: 0.75rem; }
.quick-notes-page { display: flex; max-width: 40rem; flex-direction: column; gap: 1rem; padding: 1.5rem; }
.quick-notes-form { display: flex; gap: 0.5rem; }
`;
var web_default = defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    const asNotes = (value) => (Array.isArray(value) ? value : []);
    function useNotes() {
      const [notes, setNotes] = useState([]);
      useEffect(() => {
        api.rpc.invoke("list").then((value) => setNotes(asNotes(value)));
        return api.rpc.subscribe("notes", (value) => setNotes(asNotes(value)));
      }, []);
      return notes;
    }
    const offerNotes = (value) =>
      api.composer.setMentionItems(
        asNotes(value).map((note) => ({
          id: note.id,
          label: note.text.slice(0, 60),
          description: "Quick note",
          text: note.text,
        })),
      );
    api.rpc.invoke("list").then(offerNotes);
    api.rpc.subscribe("notes", offerNotes);
    api.sidebar.addSection({
      id: "latest",
      title: "Quick notes",
      component: function LatestNotes() {
        const notes = useNotes();
        return /* @__PURE__ */ jsxs("div", {
          className: "quick-notes-sidebar",
          children: [
            notes
              .slice(-3)
              .map((note) => /* @__PURE__ */ jsx("p", { children: note.text }, note.id)),
            /* @__PURE__ */ jsx(Button, {
              size: "xs",
              variant: "ghost",
              onClick: () => api.navigate("/plugins/quick-notes/all"),
              children: notes.length === 0 ? "Add a note" : `All notes (${notes.length})`,
            }),
          ],
        });
      },
    });
    api.pages.register({
      name: "all",
      title: "Quick notes",
      component: function AllNotes() {
        const notes = useNotes();
        const [draft, setDraft] = useState("");
        return /* @__PURE__ */ jsxs("div", {
          className: "quick-notes-page",
          children: [
            /* @__PURE__ */ jsxs("form", {
              className: "quick-notes-form",
              onSubmit: (event) => {
                event.preventDefault();
                api.rpc.invoke("add", { text: draft }).then(() => setDraft(""));
              },
              children: [
                /* @__PURE__ */ jsx(Input, {
                  "aria-label": "New note",
                  placeholder: "Write a note",
                  value: draft,
                  onChange: (event) => setDraft(event.currentTarget.value),
                }),
                /* @__PURE__ */ jsx(Button, {
                  type: "submit",
                  children: "Add",
                }),
              ],
            }),
            /* @__PURE__ */ jsx("div", {
              className: "quick-notes-list",
              children: notes.toReversed().map((note) =>
                /* @__PURE__ */ jsxs(
                  "div",
                  {
                    className: "quick-notes-item",
                    children: [
                      /* @__PURE__ */ jsx("span", { children: note.text }),
                      /* @__PURE__ */ jsx(Button, {
                        size: "xs",
                        variant: "ghost",
                        onClick: () => void api.rpc.invoke("remove", { id: note.id }),
                        children: "Remove",
                      }),
                    ],
                  },
                  note.id,
                ),
              ),
            }),
          ],
        });
      },
    });
  },
});
export { web_default as default };
