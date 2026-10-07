import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  submit: vi.fn<() => Promise<AsyncResult.AsyncResult<unknown, Error>>>(),
}));
vi.mock("~/state/discussions", () => ({ discussionEnvironment: { comment: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.submit }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/toggle-group", () => ({
  Toggle: "button",
  ToggleGroup: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../pullRequest/PullRequestMarkdown", () => ({
  PullRequestMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { DiscussionComposer } from "./DiscussionComposer";

let renderer: ReactTestRenderer | null;
const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
}
function edit(text: string) {
  act(() => renderer!.root.findByType("textarea").props.onChange({ target: { value: text } }));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.submit.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

it("retains the draft on failure, prevents duplicate submits, and clears it after success", async () => {
  let finish!: (result: AsyncResult.AsyncResult<unknown, Error>) => void;
  const pending = new Promise<AsyncResult.AsyncResult<unknown, Error>>((resolve) => {
    finish = resolve;
  });
  state.submit.mockReturnValueOnce(pending).mockResolvedValueOnce(AsyncResult.success({}));
  act(() => {
    renderer = create(
      <DiscussionComposer
        threadRef={threadRef}
        url="https://github.com/team/repo/discussions/1"
        cwd="/repo"
      />,
    );
  });
  edit("My **draft**");
  act(() => {
    const submit = button("Comment").props.onClick;
    submit();
    submit();
  });
  expect(state.submit).toHaveBeenCalledTimes(1);
  expect(button("Posting...").props.disabled).toBe(true);
  await act(async () =>
    finish(AsyncResult.failure(Cause.fail(new Error("GitHub refused the comment")))),
  );
  expect(renderer!.root.findByType("textarea").props.value).toBe("My **draft**");
  expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual([
    "GitHub refused the comment",
  ]);
  await act(async () => button("Comment").props.onClick());
  expect(state.submit).toHaveBeenCalledTimes(2);
  expect(renderer!.root.findByType("textarea").props.value).toBe("");
});

it("posts a reply to its parent and collapses only after success or cancellation", async () => {
  state.submit.mockResolvedValue(AsyncResult.success({}));
  act(() => {
    renderer = create(
      <DiscussionComposer
        threadRef={threadRef}
        url="https://github.com/team/repo/discussions/1"
        cwd="/repo"
        replyToId="parent"
      />,
    );
  });
  act(() => renderer!.root.findByType("input").props.onFocus());
  edit("A reply");
  await act(async () => button("Reply").props.onClick());
  expect(state.submit).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      url: "https://github.com/team/repo/discussions/1",
      body: "A reply",
      replyToId: "parent",
    },
  });
  expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
  act(() => renderer!.root.findByType("input").props.onFocus());
  edit("Cancelled reply");
  act(() => button("Cancel").props.onClick());
  act(() => renderer!.root.findByType("input").props.onFocus());
  expect(renderer!.root.findByType("textarea").props.value).toBe("");
  expect(state.submit).toHaveBeenCalledTimes(1);
});

it("keeps text entered while the reply input expands into the markdown editor", async () => {
  state.submit.mockResolvedValue(AsyncResult.success({}));
  act(() => {
    renderer = create(
      <DiscussionComposer
        threadRef={threadRef}
        url="https://github.com/team/repo/discussions/1"
        cwd="/repo"
        replyToId="parent"
      />,
    );
  });
  act(() => {
    const input = renderer!.root.findByType("input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "First words" } });
  });
  expect(renderer!.root.findByType("textarea").props.value).toBe("First words");
  await act(async () => button("Reply").props.onClick());
  expect(state.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ body: "First words", replyToId: "parent" }),
    }),
  );
});

it("collapses on outside clicks and restores the reply draft when reopened", async () => {
  const ownerDocument = new EventTarget();
  const editor = Object.assign(new EventTarget(), { ownerDocument });
  act(() => {
    renderer = create(
      <DiscussionComposer
        threadRef={threadRef}
        url="https://github.com/team/repo/discussions/1"
        cwd="/repo"
        replyToId="parent"
      />,
      { createNodeMock: (element) => (element.type === "div" ? editor : null) },
    );
  });
  act(() => renderer!.root.findByType("input").props.onFocus());
  edit("Keep this draft");
  const inside = new Event("pointerdown");
  vi.spyOn(inside, "composedPath").mockReturnValue([editor, ownerDocument]);
  act(() => ownerDocument.dispatchEvent(inside));
  expect(renderer!.root.findByType("textarea").props.value).toBe("Keep this draft");
  act(() => ownerDocument.dispatchEvent(new Event("pointerdown")));
  expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
  expect(renderer!.root.findByType("input").props.value).toBe("Keep this draft");
  act(() => renderer!.root.findByType("input").props.onFocus());
  expect(renderer!.root.findByType("textarea").props.value).toBe("Keep this draft");
  expect(state.submit).not.toHaveBeenCalled();
});
