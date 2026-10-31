import { Button, Input } from "@t3tools/plugin-sdk/ui";
import { defineWebPlugin } from "@t3tools/plugin-sdk/web";
import { useEffect, useState } from "react";

// Built to web.js by `vp build --config examples/quick-notes/vite.config.ts` from
// packages/plugin-sdk.
interface Note {
  readonly id: string;
  readonly text: string;
  readonly at: string;
}

const css = `
.quick-notes-list { display: flex; flex-direction: column; gap: 0.25rem; }
.quick-notes-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; }
.quick-notes-item span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.quick-notes-sidebar { padding-inline: 0.5rem; font-size: 0.75rem; }
.quick-notes-page { display: flex; max-width: 40rem; flex-direction: column; gap: 1rem; padding: 1.5rem; }
.quick-notes-form { display: flex; gap: 0.5rem; }
`;

export default defineWebPlugin({
  activate(api) {
    api.injectStyles(css);
    const asNotes = (value: unknown) => (Array.isArray(value) ? (value as Array<Note>) : []);

    function useNotes() {
      const [notes, setNotes] = useState<ReadonlyArray<Note>>([]);
      useEffect(() => {
        void api.rpc.invoke("list").then((value) => setNotes(asNotes(value)));
        return api.rpc.subscribe("notes", (value) => setNotes(asNotes(value)));
      }, []);
      return notes;
    }

    api.sidebar.addSection({
      id: "latest",
      title: "Quick notes",
      component: function LatestNotes() {
        const notes = useNotes();
        return (
          <div className="quick-notes-sidebar">
            {notes.slice(-3).map((note) => (
              <p key={note.id}>{note.text}</p>
            ))}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => api.navigate("/plugins/quick-notes/all")}
            >
              {notes.length === 0 ? "Add a note" : `All notes (${notes.length})`}
            </Button>
          </div>
        );
      },
    });

    api.pages.register({
      name: "all",
      title: "Quick notes",
      component: function AllNotes() {
        const notes = useNotes();
        const [draft, setDraft] = useState("");
        return (
          <div className="quick-notes-page">
            <form
              className="quick-notes-form"
              onSubmit={(event) => {
                event.preventDefault();
                void api.rpc.invoke("add", { text: draft }).then(() => setDraft(""));
              }}
            >
              <Input
                aria-label="New note"
                placeholder="Write a note"
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
              <Button type="submit">Add</Button>
            </form>
            <div className="quick-notes-list">
              {notes.toReversed().map((note) => (
                <div key={note.id} className="quick-notes-item">
                  <span>{note.text}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void api.rpc.invoke("remove", { id: note.id })}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>
        );
      },
    });
  },
});
