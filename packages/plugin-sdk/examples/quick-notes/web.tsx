import { useAtomValue } from "@effect/atom-react";
import * as Atom from "@t3tools/plugin-sdk/atom";
import { Button, Input } from "@t3tools/plugin-sdk/ui";
import { defineWebPlugin } from "@t3tools/plugin-sdk/web";
import { useState } from "react";

import type { Note, QuickNotesRpc } from "./rpc.ts";

const css = `
.quick-notes-list { display: flex; flex-direction: column; gap: 0.25rem; }
.quick-notes-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; }
.quick-notes-item span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.quick-notes-sidebar { padding-inline: 0.5rem; font-size: 0.75rem; }
.quick-notes-page { display: flex; max-width: 40rem; flex-direction: column; gap: 1rem; padding: 1.5rem; }
.quick-notes-form { display: flex; gap: 0.5rem; }
`;

export default defineWebPlugin<QuickNotesRpc>({
  activate(api) {
    api.injectStyles(css);
    // A read-only client, for one, is refused; say so instead of leaving the draft as it was.
    const showFailure = (error: unknown) =>
      api.toast({
        type: "error",
        title: "Quick notes couldn't save that",
        description: error instanceof Error ? error.message : String(error),
      });

    // One list for the sidebar and the page, following the server's channel while either shows.
    const notesAtom = Atom.make((get): ReadonlyArray<Note> => {
      void api.rpc.invoke("list").then((notes) => get.setSelf(notes));
      get.addFinalizer(api.rpc.subscribe("notes", (notes) => get.setSelf(notes)));
      return [];
    });
    const useNotes = () => useAtomValue(notesAtom);

    // Every note is also an `@` item that puts the note into the message.
    const offerNotes = (notes: ReadonlyArray<Note>) =>
      api.composer.setMentionItems(
        notes.map((note) => ({
          id: note.id,
          label: note.text.slice(0, 60),
          description: "Quick note",
          text: `(Note: ${note.text})`,
        })),
      );
    void api.rpc.invoke("list").then(offerNotes);
    api.rpc.subscribe("notes", offerNotes);

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
              onClick={() => api.navigate(`/plugins/${api.id}/all`)}
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
                void api.rpc.invoke("add", { text: draft }).then(() => setDraft(""), showFailure);
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
                    onClick={() =>
                      void api.rpc.invoke("remove", { id: note.id }).catch(showFailure)
                    }
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
