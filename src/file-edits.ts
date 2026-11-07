import path from "node:path";

import { isRecord, type JsonObject } from "./acp.js";

// Copilot's file-writing tools. Their start events carry the absolute path they write.
const fileEditToolNames: ReadonlySet<string> = new Set(["edit", "create"]);
export const maximumRecentFileEdits = 200;
const maximumCheckedDirectories = 20;

// Persisted history holds every tool result, so keep only file-edit calls: the start events of edit and create,
// and completions that report the files they changed. Completions carry no tool name, so they are matched by call id.
export function fileEditEventFilter(): (event: JsonObject) => boolean {
  const editCallIds = new Set<string>();
  return (event) => {
    const data = isRecord(event.data) ? event.data : undefined;
    if (typeof data?.toolCallId !== "string") {
      return false;
    }
    if (event.type === "tool.execution_start") {
      if (typeof data.toolName === "string" && fileEditToolNames.has(data.toolName)) {
        editCallIds.add(data.toolCallId);
        return true;
      }
      return false;
    }
    return event.type === "tool.execution_complete" &&
      (editCallIds.has(data.toolCallId) || Array.isArray(data.fileEdits));
  };
}

function absolutePaths(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && path.isAbsolute(value));
}

// The CLI reports the files a write changed on completion. This covers apply_patch, whose start arguments are patch text.
function reportedFilePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return absolutePaths(value.map((entry) => (isRecord(entry) ? entry.path : undefined)));
}

// Live tool updates from the ACP session. Edit tools have kind "edit"; their start lists locations and
// their completion lists the diffs of the files they changed.
export function observeToolUpdate(edits: RecentFileEdits, update: JsonObject): void {
  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
  if (toolCallId === undefined) {
    return;
  }
  if (update.sessionUpdate === "tool_call" && update.kind === "edit") {
    const locations = Array.isArray(update.locations)
      ? update.locations.map((location) => (isRecord(location) ? location.path : undefined))
      : [];
    const rawInput = isRecord(update.rawInput) ? update.rawInput : undefined;
    edits.started(toolCallId, absolutePaths([...locations, rawInput?.path]));
  } else if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
    const diffPaths = Array.isArray(update.content)
      ? update.content.map((item) => (isRecord(item) && item.type === "diff" ? item.path : undefined))
      : [];
    edits.completed(toolCallId, absolutePaths(diffPaths), update.status === "completed");
  }
}

export class RecentFileEdits {
  // Insertion order is recency: a file moves to the end each time a successful edit touches it.
  private readonly files = new Set<string>();
  // Every edited file, without the recency cap, so the Current changes view lists a whole conversation.
  private readonly editedFiles = new Set<string>();
  private readonly pendingFiles = new Map<string, string[]>();
  private readonly countedCalls = new Set<string>();

  public observe(event: JsonObject): void {
    const data = isRecord(event.data) ? event.data : undefined;
    if (typeof data?.toolCallId !== "string") {
      return;
    }
    if (event.type === "tool.execution_start") {
      const args = isRecord(data.arguments) ? data.arguments : undefined;
      if (typeof data.toolName === "string" && fileEditToolNames.has(data.toolName)) {
        this.started(data.toolCallId, absolutePaths([args?.path]));
      }
    } else if (event.type === "tool.execution_complete") {
      this.completed(data.toolCallId, reportedFilePaths(data.fileEdits), data.success !== false);
    }
  }

  // Start-time paths are a fallback for completions that do not report the files they changed.
  public started(toolCallId: string, filePaths: readonly string[]): void {
    if (filePaths.length > 0) {
      this.pendingFiles.set(toolCallId, [...filePaths]);
    }
  }

  public completed(toolCallId: string, reportedPaths: readonly string[] | undefined, success: boolean): void {
    const pending = this.pendingFiles.get(toolCallId);
    this.pendingFiles.delete(toolCallId);
    const filePaths = reportedPaths?.length ? reportedPaths : pending ?? [];
    // Live and replayed events can overlap, so each completed call is counted once.
    if (filePaths.length === 0 || !success || this.countedCalls.has(toolCallId)) {
      return;
    }
    this.countedCalls.add(toolCallId);
    for (const filePath of filePaths) {
      this.touch(filePath);
    }
  }

  public newestFirst(): string[] {
    return [...this.files].reverse();
  }

  public allFiles(): string[] {
    return [...this.editedFiles];
  }

  private touch(filePath: string): void {
    this.editedFiles.add(filePath);
    this.files.delete(filePath);
    this.files.add(filePath);
    if (this.files.size > maximumRecentFileEdits) {
      const oldest = this.files.values().next().value;
      if (oldest !== undefined) {
        this.files.delete(oldest);
      }
    }
  }
}

// Edits to scratch files outside any repository are skipped, so the newest edit inside a repository wins.
// The search stops after a few directories so a conversation of scratch edits cannot make every refresh slow.
export async function latestEditedRepository(
  newestFiles: readonly string[],
  toplevel: (directory: string) => Promise<string | undefined>
): Promise<string | undefined> {
  const checked = new Set<string>();
  for (const filePath of newestFiles) {
    const directory = path.dirname(filePath);
    if (checked.has(directory)) {
      continue;
    }
    if (checked.size === maximumCheckedDirectories) {
      break;
    }
    checked.add(directory);
    const root = await toplevel(directory);
    if (root !== undefined) {
      return root;
    }
  }
  return undefined;
}
