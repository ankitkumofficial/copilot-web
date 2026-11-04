import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "./acp.js";
import { fileEditEventFilter, latestEditedRepository, maximumRecentFileEdits, observeToolUpdate, RecentFileEdits } from "./file-edits.js";

function toolStart(toolCallId: string, toolName: string, args: JsonObject): JsonObject {
  return { type: "tool.execution_start", data: { toolCallId, toolName, arguments: args } };
}

function toolComplete(toolCallId: string, success = true): JsonObject {
  return { type: "tool.execution_complete", data: { toolCallId, success } };
}

function editOf(toolCallId: string, filePath: string, toolName = "edit"): JsonObject[] {
  return [toolStart(toolCallId, toolName, { path: filePath }), toolComplete(toolCallId)];
}

test("a file counts as edited only once its edit completes successfully", () => {
  const edits = new RecentFileEdits();
  edits.observe(toolStart("call-1", "edit", { path: "/work/app/a.ts" }));
  assert.deepEqual(edits.newestFirst(), []);
  edits.observe(toolComplete("call-1", false));
  assert.deepEqual(edits.newestFirst(), []);

  edits.observe(toolStart("call-2", "create", { path: "/work/app/b.ts" }));
  edits.observe(toolComplete("call-2"));
  assert.deepEqual(edits.newestFirst(), ["/work/app/b.ts"]);
});

test("reads, relative paths, and other tools never count as edits", () => {
  const edits = new RecentFileEdits();
  edits.observe(toolStart("view-1", "view", { path: "/work/app/a.ts" }));
  edits.observe(toolComplete("view-1"));
  edits.observe(toolStart("edit-relative", "edit", { path: "src/a.ts" }));
  edits.observe(toolComplete("edit-relative"));
  edits.observe(toolStart("edit-missing-path", "edit", {}));
  edits.observe(toolComplete("edit-missing-path"));
  assert.deepEqual(edits.newestFirst(), []);
});

test("the most recently edited file comes first and an overlapping completion is counted once", () => {
  const edits = new RecentFileEdits();
  for (const event of [
    ...editOf("call-1", "/work/app/a.ts"),
    ...editOf("call-2", "/work/app/b.ts"),
    ...editOf("call-3", "/work/app/a.ts")
  ]) {
    edits.observe(event);
  }
  assert.deepEqual(edits.newestFirst(), ["/work/app/a.ts", "/work/app/b.ts"]);

  // Live and replayed events can overlap; a repeated completion must not move a file again.
  edits.observe(toolComplete("call-2"));
  assert.deepEqual(edits.newestFirst(), ["/work/app/a.ts", "/work/app/b.ts"]);
});

test("only the newest files are kept", () => {
  const edits = new RecentFileEdits();
  for (let index = 0; index <= maximumRecentFileEdits; index += 1) {
    for (const event of editOf(`call-${index}`, `/work/app/file-${index}.ts`)) {
      edits.observe(event);
    }
  }
  const newest = edits.newestFirst();
  assert.equal(newest.length, maximumRecentFileEdits);
  assert.equal(newest[0], `/work/app/file-${maximumRecentFileEdits}.ts`);
  assert.equal(newest.includes("/work/app/file-0.ts"), false);
});

test("every edited file is kept for the conversation, even once the newest list has dropped it", () => {
  const edits = new RecentFileEdits();
  for (let index = 0; index <= maximumRecentFileEdits; index += 1) {
    for (const event of editOf(`call-${index}`, `/work/app/file-${index}.ts`)) {
      edits.observe(event);
    }
  }
  const all = edits.allFiles();
  assert.equal(all.length, maximumRecentFileEdits + 1);
  assert.equal(all.includes("/work/app/file-0.ts"), true);
});

test("the persisted-event filter keeps only file-edit calls", () => {
  const include = fileEditEventFilter();
  const events: JsonObject[] = [
    { type: "user.message", data: { content: "Fix it" } },
    toolStart("view-1", "view", { path: "/work/app/a.ts" }),
    toolComplete("view-1"),
    toolStart("edit-1", "edit", { path: "/work/app/a.ts" }),
    toolComplete("edit-1"),
    toolComplete("unknown-1")
  ];
  assert.deepEqual(events.filter(include).map((event) => (event.data as JsonObject).toolCallId ?? event.type), [
    "edit-1",
    "edit-1"
  ]);
});

test("completions that report their changed files count, including apply_patch whose start carries patch text", () => {
  const edits = new RecentFileEdits();
  edits.observe({
    type: "tool.execution_start",
    data: { toolCallId: "patch-1", toolName: "apply_patch", arguments: "*** Begin Patch\n*** End Patch\n" }
  });
  edits.observe({
    type: "tool.execution_complete",
    data: { toolCallId: "patch-1", success: true, fileEdits: [
      { path: "/work/app/notes.txt", kind: "edit" },
      { path: "/work/app/created.txt", kind: "create" }
    ] }
  });
  assert.deepEqual(edits.newestFirst(), ["/work/app/created.txt", "/work/app/notes.txt"]);

  edits.observe({
    type: "tool.execution_complete",
    data: { toolCallId: "patch-2", success: true, fileEdits: [{ path: "src/relative.ts", kind: "edit" }] }
  });
  assert.deepEqual(edits.newestFirst(), ["/work/app/created.txt", "/work/app/notes.txt"]);
});

test("the persisted-event filter keeps completions that report changed files", () => {
  const include = fileEditEventFilter();
  assert.equal(include({
    type: "tool.execution_complete",
    data: { toolCallId: "patch-1", success: true, fileEdits: [{ path: "/work/app/a.ts", kind: "edit" }] }
  }), true);
  assert.equal(include({ type: "tool.execution_complete", data: { toolCallId: "view-1", success: true } }), false);
});

test("live tool updates count edits by kind, reported diffs, and failures", () => {
  const edits = new RecentFileEdits();
  observeToolUpdate(edits, {
    sessionUpdate: "tool_call", toolCallId: "view-1", kind: "read", status: "pending",
    locations: [{ path: "/work/app/a.ts" }]
  });
  observeToolUpdate(edits, { sessionUpdate: "tool_call_update", toolCallId: "view-1", status: "completed" });
  assert.deepEqual(edits.newestFirst(), []);

  // apply_patch: its start carries patch text, and its completion lists the diffs of the files it changed.
  observeToolUpdate(edits, {
    sessionUpdate: "tool_call", toolCallId: "patch-1", kind: "edit", status: "pending",
    rawInput: "*** Begin Patch\n*** End Patch\n"
  });
  observeToolUpdate(edits, {
    sessionUpdate: "tool_call_update", toolCallId: "patch-1", status: "completed",
    content: [
      { type: "diff", path: "/work/app/notes.txt", oldText: "a", newText: "b" },
      { type: "diff", path: "/work/app/created.txt", oldText: "", newText: "c" }
    ]
  });
  assert.deepEqual(edits.newestFirst(), ["/work/app/created.txt", "/work/app/notes.txt"]);

  observeToolUpdate(edits, {
    sessionUpdate: "tool_call", toolCallId: "edit-1", kind: "edit", status: "pending",
    locations: [{ path: "/work/other/b.ts" }]
  });
  observeToolUpdate(edits, { sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "failed" });
  assert.deepEqual(edits.newestFirst(), ["/work/app/created.txt", "/work/app/notes.txt"]);

  // Without reported diffs, a completed edit falls back to the locations of its start.
  observeToolUpdate(edits, {
    sessionUpdate: "tool_call", toolCallId: "edit-2", kind: "edit", status: "pending",
    locations: [{ path: "/work/other/b.ts" }]
  });
  observeToolUpdate(edits, { sessionUpdate: "tool_call_update", toolCallId: "edit-2", status: "completed" });
  assert.deepEqual(edits.newestFirst(), ["/work/other/b.ts", "/work/app/created.txt", "/work/app/notes.txt"]);
});

test("the latest edited repository skips edits outside repositories", async () => {
  const roots = new Map<string, string>([
    ["/work/app/src", "/work/app"],
    ["/work/other", "/work/other"]
  ]);
  const looked: string[] = [];
  const toplevel = async (directory: string) => {
    looked.push(directory);
    return roots.get(directory);
  };

  assert.equal(
    await latestEditedRepository(["/work/app/src/a.ts", "/work/other/b.ts"], toplevel),
    "/work/app"
  );
  assert.equal(
    await latestEditedRepository(["/tmp/notes/scratch.md", "/work/app/src/a.ts"], toplevel),
    "/work/app"
  );
  assert.equal(await latestEditedRepository(["/tmp/notes/scratch.md"], toplevel), undefined);
  assert.equal(await latestEditedRepository([], toplevel), undefined);
  // Each directory is asked about once per resolution.
  assert.deepEqual(looked.filter((directory) => directory === "/work/app/src"), ["/work/app/src", "/work/app/src"]);
});

test("the repository search gives up after a few directories outside repositories", async () => {
  const looked: string[] = [];
  const toplevel = async (directory: string) => {
    looked.push(directory);
    return directory === "/work/app" ? directory : undefined;
  };
  const scratch = Array.from({ length: 25 }, (_, index) => `/tmp/scratch-${index}/note.md`);
  assert.equal(await latestEditedRepository([...scratch, "/work/app/a.ts"], toplevel), undefined);
  assert.equal(looked.length, 20);
});
