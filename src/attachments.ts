import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "./acp.js";

export interface StoredAttachment {
  name: string;
  mimeType: string;
  data: string;
}

const attachmentUriPrefix = "urn:copilot-web:attachment:";
// Copilot CLI persists embedded resources as deleted temp files. Their displayName is derived
// from the resource URI by replacing characters other than letters, digits, "." and "-" with "_".
const attachmentReferencePattern =
  /^urn[:_]copilot-web[:_]attachment[:_]([0-9a-f]{64})(?:[:_]|$)/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

export function attachmentId(attachment: StoredAttachment): string {
  return createHash("sha256")
    .update(JSON.stringify([attachment.name, attachment.mimeType, attachment.data]))
    .digest("hex");
}

export function attachmentUri(attachment: StoredAttachment): string {
  return `${attachmentUriPrefix}${attachmentId(attachment)}:${encodeURIComponent(attachment.name)}`;
}

export function attachmentReferenceId(value: unknown): string | undefined {
  if (!isRecord(value) || (typeof value.data === "string" && value.data.length > 0)) {
    return undefined;
  }
  for (const candidate of [value.displayName, value.uri]) {
    if (typeof candidate === "string") {
      const id = attachmentReferencePattern.exec(candidate)?.[1];
      if (id) {
        return id;
      }
    }
  }
  return undefined;
}

function referenceIds(events: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (!isRecord(event) || event.type !== "user.message" || !isRecord(event.data)) {
      continue;
    }
    const attachments = event.data.attachments;
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      const id = attachmentReferenceId(attachment);
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

export function hydrateAttachmentEvent<T>(
  event: T,
  resolve: (id: string) => StoredAttachment | undefined
): T {
  if (!isRecord(event) || event.type !== "user.message" || !isRecord(event.data)) {
    return event;
  }
  const attachments = event.data.attachments;
  if (!Array.isArray(attachments)) {
    return event;
  }
  let changed = false;
  const hydrated = attachments.map((attachment: unknown) => {
    const id = attachmentReferenceId(attachment);
    const stored = id ? resolve(id) : undefined;
    if (!stored || !isRecord(attachment)) {
      return attachment;
    }
    changed = true;
    return {
      ...attachment,
      displayName: stored.name,
      mimeType: stored.mimeType,
      data: stored.data
    };
  });
  return changed
    ? { ...event, data: { ...event.data, attachments: hydrated } } as T
    : event;
}

function parseStoredAttachment(value: unknown): StoredAttachment | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.data !== "string" ||
    value.data.length % 4 !== 0 ||
    !base64Pattern.test(value.data)
  ) {
    return undefined;
  }
  return { name: value.name, mimeType: value.mimeType, data: value.data };
}

// Display-only copies of non-image prompt attachments, which Copilot CLI history does not retain.
export class AttachmentStore {
  public constructor(private readonly directory: string) {}

  private sessionDirectory(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || sessionId.length > 200) {
      throw new Error("Invalid conversation id for attachment storage");
    }
    return path.join(this.directory, sessionId);
  }

  public async save(sessionId: string, attachments: readonly StoredAttachment[]): Promise<void> {
    if (attachments.length === 0) {
      return;
    }
    const directory = this.sessionDirectory(sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const attachment of attachments) {
      const file = path.join(directory, `${attachmentId(attachment)}.json`);
      const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(attachment), { mode: 0o600 });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    }
  }

  public async load(sessionId: string, id: string): Promise<StoredAttachment | undefined> {
    if (!/^[0-9a-f]{64}$/.test(id)) {
      return undefined;
    }
    let content: string;
    try {
      content = await readFile(path.join(this.sessionDirectory(sessionId), `${id}.json`), "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    let attachment: StoredAttachment | undefined;
    try {
      attachment = parseStoredAttachment(JSON.parse(content));
    } catch {
      return undefined;
    }
    return attachment && attachmentId(attachment) === id ? attachment : undefined;
  }

  public async hydrateEvents<T>(sessionId: string, events: readonly T[]): Promise<T[]> {
    const ids = referenceIds(events);
    if (ids.size === 0) {
      return [...events];
    }
    const resolved = new Map<string, StoredAttachment>();
    await Promise.all([...ids].map(async (id) => {
      try {
        const attachment = await this.load(sessionId, id);
        if (attachment) {
          resolved.set(id, attachment);
        }
      } catch (error) {
        console.warn(
          `[attachments] Unable to restore attachment ${id} for ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }));
    return events.map((event) => hydrateAttachmentEvent(event, (id) => resolved.get(id)));
  }

  public async hydratePage(sessionId: string, page: unknown): Promise<unknown> {
    if (!isRecord(page) || !Array.isArray(page.events)) {
      return page;
    }
    return { ...page, events: await this.hydrateEvents(sessionId, page.events) };
  }

  public async deleteSession(sessionId: string): Promise<void> {
    await rm(this.sessionDirectory(sessionId), { recursive: true, force: true });
  }
}
