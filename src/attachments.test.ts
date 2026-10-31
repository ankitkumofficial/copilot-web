import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  AttachmentStore,
  attachmentId,
  attachmentReferenceId,
  attachmentUri,
  hydrateAttachmentEvent
} from "./attachments.js";

const attachment = {
  name: "Bericht (final) ü.log",
  mimeType: "text/plain",
  data: Buffer.from("hello attachment").toString("base64")
};

async function temporaryStore(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-attachments-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new AttachmentStore(directory) };
}

test("recovers attachment ids from CLI display names derived from resource URIs", () => {
  const id = attachmentId(attachment);
  const uri = attachmentUri(attachment);
  assert.equal(uri, `urn:copilot-web:attachment:${id}:Bericht%20(final)%20%C3%BC.log`);
  assert.equal(attachmentReferenceId({
    type: "file",
    path: "/tmp/acp-resource-1.bin",
    displayName: uri.replace(/[^A-Za-z0-9.-]/g, "_")
  }), id);
  assert.equal(attachmentReferenceId({ uri }), id);
  assert.equal(attachmentReferenceId({ displayName: "urn_copilot-web_attachment_0_notes.txt" }), undefined);
  assert.equal(attachmentReferenceId({ displayName: "notes.txt" }), undefined);
  assert.equal(attachmentReferenceId({ displayName: uri, data: attachment.data }), undefined);
});

test("hydrates only user-message references that resolve", () => {
  const id = attachmentId(attachment);
  const reference = { type: "file", displayName: attachmentUri(attachment) };
  const missing = { type: "file", displayName: `urn:copilot-web:attachment:${"0".repeat(64)}:x` };
  const event = {
    type: "user.message",
    data: { messageId: "user-1", attachments: [reference, missing] }
  };
  const hydrated = hydrateAttachmentEvent(event, (candidate) => (
    candidate === id ? attachment : undefined
  ));
  assert.deepEqual(hydrated.data.attachments, [
    { ...reference, displayName: attachment.name, mimeType: attachment.mimeType, data: attachment.data },
    missing
  ]);
  assert.deepEqual(event.data.attachments, [reference, missing]);

  const assistant = { type: "assistant.message", data: { attachments: [reference] } };
  assert.equal(hydrateAttachmentEvent(assistant, () => attachment), assistant);
});

test("stores, verifies, hydrates, and deletes attachments per conversation", async (t) => {
  const { directory, store } = await temporaryStore(t);
  const id = attachmentId(attachment);
  await store.save("session-1", [attachment, attachment]);
  assert.deepEqual(await readdir(path.join(directory, "session-1")), [`${id}.json`]);
  assert.deepEqual(await store.load("session-1", id), attachment);
  assert.equal(await store.load("session-2", id), undefined);
  assert.equal(await store.load("session-1", "../escape"), undefined);

  const events = await store.hydrateEvents("session-1", [{
    type: "user.message",
    data: { attachments: [{ type: "file", displayName: attachmentUri(attachment) }] }
  }]);
  assert.deepEqual(events[0]?.data.attachments, [{
    type: "file",
    displayName: attachment.name,
    mimeType: attachment.mimeType,
    data: attachment.data
  }]);
  const page = await store.hydratePage("session-1", { cursor: "c", events });
  assert.deepEqual(page, { cursor: "c", events });

  await writeFile(
    path.join(directory, "session-1", `${id}.json`),
    JSON.stringify({ ...attachment, data: Buffer.from("changed").toString("base64") })
  );
  assert.equal(await store.load("session-1", id), undefined);

  await store.deleteSession("session-1");
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(store.save("../escape", [attachment]), /Invalid conversation id/);
});
