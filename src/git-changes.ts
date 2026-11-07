import { spawn } from "node:child_process";
import { lstat, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const emptyTreeObject = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const maximumStatusFiles = 2_000;
export const maximumDiffBytes = 1024 * 1024;
export const maximumUntrackedFileBytes = 2 * 1024 * 1024;
export const gitTimeoutMs = 10_000;
const maximumGitOutputBytes = 8 * 1024 * 1024;
const fullContextLines = 100_000;
const binaryProbeBytes = 8 * 1024;
const untrackedReadConcurrency = 16;

export type GitChangesErrorCode =
  | "git_unavailable"
  | "git_timeout"
  | "git_failed"
  | "invalid_path"
  | "invalid_repository"
  | "repository_not_allowed"
  | "file_not_changed"
  | "file_not_resettable"
  | "index_locked";

export class GitChangesError extends Error {
  public readonly status: number;
  public readonly code: GitChangesErrorCode;

  public constructor(status: number, message: string, code: GitChangesErrorCode) {
    super(message);
    this.name = "GitChangesError";
    this.status = status;
    this.code = code;
  }
}

export interface RunGitOptions {
  acceptExitCodes?: readonly number[];
  maxBytes?: number;
  // Stop reading at maxBytes and report truncation instead of failing.
  truncate?: boolean;
  timeoutMs?: number;
  command?: string;
}

export interface GitResult {
  stdout: Buffer;
  exitCode: number;
  truncated: boolean;
}

const gitFixedArguments = [
  "-c", "core.quotePath=false",
  "-c", "color.ui=false",
  "-c", "core.fsmonitor=false",
  "--no-optional-locks",
  "--literal-pathspecs"
];

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C"
  };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_CEILING_DIRECTORIES"]) {
    delete environment[name];
  }
  return environment;
}

export async function runGit(
  repo: string,
  args: readonly string[],
  options: RunGitOptions = {}
): Promise<GitResult> {
  const maxBytes = options.maxBytes ?? maximumGitOutputBytes;
  const acceptExitCodes = options.acceptExitCodes ?? [0];
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn(options.command ?? "git", [...gitFixedArguments, ...args], {
      cwd: repo,
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (callback: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        callback();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? gitTimeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) {
        return;
      }
      if (bytes + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - bytes));
        bytes = maxBytes;
        truncated = true;
        if (!options.truncate) {
          child.kill("SIGKILL");
          finish(() => reject(new GitChangesError(
            500,
            `git ${args[0] ?? ""} produced more output than allowed`,
            "git_failed"
          )));
          return;
        }
        child.stdout.destroy();
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4096) {
        stderr += chunk;
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === "ENOENT") {
          // spawn also reports ENOENT for a missing working directory.
          void stat(repo).then(
            () => reject(new GitChangesError(503, "Git is not installed or not on the server's PATH", "git_unavailable")),
            () => reject(new GitChangesError(404, "Repository directory does not exist", "invalid_repository"))
          );
          return;
        }
        reject(error);
      });
    });
    child.once("close", (code: number | null) => {
      finish(() => {
        if (timedOut) {
          reject(new GitChangesError(504, `git ${args[0] ?? ""} timed out`, "git_timeout"));
          return;
        }
        const stdout = Buffer.concat(chunks, bytes);
        if (truncated && options.truncate) {
          resolve({ stdout, exitCode: code ?? 0, truncated: true });
          return;
        }
        if (code === null || !acceptExitCodes.includes(code)) {
          const detail = stderr.trim().split("\n", 1)[0] ?? "";
          reject(new GitChangesError(
            500,
            `git ${args[0] ?? ""} failed${detail ? `: ${detail}` : ""}`,
            "git_failed"
          ));
          return;
        }
        resolve({ stdout, exitCode: code, truncated: false });
      });
    });
  });
}

export function isWithinOrEqual(directory: string, filePath: string): boolean {
  const relativePath = path.relative(directory, filePath);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

export async function resolveToplevel(directory: string, command?: string): Promise<string | undefined> {
  const result = await runGit(directory, ["rev-parse", "--show-toplevel"], {
    acceptExitCodes: [0, 128],
    ...(command ? { command } : {})
  });
  const toplevel = result.stdout.toString("utf8").trim();
  if (result.exitCode !== 0 || !toplevel) {
    return undefined;
  }
  return realpath(toplevel);
}

export interface RepositoryEntry {
  root: string;
  name: string;
  // Path below the projects folder with "/" separators, such as "team/service".
  relativePath: string;
}

interface RepositorySearchFolder {
  directory: string;
  relativePath: string;
}

// Repositories are found up to this many folders below the projects folder. Their contents are not
// searched, and hidden and node_modules folders are skipped.
const maximumRepositoryDepth = 3;
const maximumRepositoryScanDirectories = 5_000;

function isSearchableFolder(name: string): boolean {
  return !name.startsWith(".") && name !== "node_modules";
}

export async function listProjectRepositories(projectsDirectory: string): Promise<RepositoryEntry[]> {
  const root = await realpath(projectsDirectory);
  const repositories: RepositoryEntry[] = [];
  let folders: RepositorySearchFolder[] = [{ directory: root, relativePath: "" }];
  let scanned = 0;
  // Breadth-first, so shallow repositories are found before the scan budget is spent.
  for (let depth = 1; depth <= maximumRepositoryDepth && folders.length > 0; depth += 1) {
    const next: RepositorySearchFolder[] = [];
    for (const folder of folders) {
      if (scanned >= maximumRepositoryScanDirectories) {
        break;
      }
      scanned += 1;
      const entries = await readdir(folder.directory, { withFileTypes: true }).catch((error: unknown) => {
        if (depth === 1) {
          throw error;
        }
        return [];
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const directory = path.join(folder.directory, entry.name);
        const relativePath = folder.relativePath ? `${folder.relativePath}/${entry.name}` : entry.name;
        if (await lstat(path.join(directory, ".git")).then(() => true, () => false)) {
          repositories.push({ root: directory, name: entry.name, relativePath });
        } else if (depth < maximumRepositoryDepth && isSearchableFolder(entry.name)) {
          next.push({ directory, relativePath });
        }
      }
    }
    folders = next;
  }
  return repositories.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export type FileChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted";

export type ChangeSection = "staged" | "unstaged";

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  // A partially staged file has one entry in each section.
  section: ChangeSection;
  status: FileChangeStatus;
  index: string;
  worktree: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  tooLarge: boolean;
  directory: boolean;
}

export interface RepositoryStatus {
  root: string;
  name: string;
  branch: string | null;
  detached: boolean;
  headShort: string | null;
  hasCommits: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  totals: { files: number; additions: number; deletions: number };
  // The whole repository's file count, even when files is limited to a scope, so badges stay repository-wide.
  repositoryTotals: { files: number; truncated: boolean };
  truncated: boolean;
}

interface ParsedStatus {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  truncated: boolean;
}

const statusByLetter: Record<string, FileChangeStatus> = {
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange"
};

// Porcelain v2 reports staged (X) and unstaged (Y) changes in one record; each becomes its own section entry.
function entriesFor(record: string, xy: string, filePath: string, oldPath: string | null): ChangedFile[] {
  const index = xy[0] ?? ".";
  const worktree = xy[1] ?? ".";
  const entry = (section: ChangeSection, status: FileChangeStatus, entryOldPath: string | null): ChangedFile => ({
    path: filePath,
    oldPath: entryOldPath,
    section,
    status,
    index,
    worktree,
    additions: null,
    deletions: null,
    binary: false,
    tooLarge: false,
    directory: false
  });
  if (record === "u") {
    return [entry("unstaged", "conflicted", null)];
  }
  if (record === "?") {
    return [entry("unstaged", "untracked", null)];
  }
  const entries: ChangedFile[] = [];
  if (index !== ".") {
    entries.push(entry("staged", statusByLetter[index] ?? "modified", oldPath));
  }
  if (worktree !== ".") {
    entries.push(entry("unstaged", statusByLetter[worktree] ?? "modified", null));
  }
  return entries;
}

function splitFields(record: string, count: number): { fields: string[]; rest: string } | undefined {
  const fields: string[] = [];
  let offset = 0;
  for (let field = 0; field < count; field += 1) {
    const space = record.indexOf(" ", offset);
    if (space < 0) {
      return undefined;
    }
    fields.push(record.slice(offset, space));
    offset = space + 1;
  }
  return { fields, rest: record.slice(offset) };
}

export function parsePorcelainStatus(output: string, limit = maximumStatusFiles): ParsedStatus {
  const result: ParsedStatus = {
    oid: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    truncated: false
  };
  let records = 0;
  const tokens = output.split("\0");
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position] ?? "";
    if (!token) {
      continue;
    }
    if (token.startsWith("# ")) {
      const [key = "", ...values] = token.slice(2).split(" ");
      const value = values.join(" ");
      if (key === "branch.oid") {
        result.oid = value;
      } else if (key === "branch.head") {
        result.head = value;
      } else if (key === "branch.upstream") {
        result.upstream = value;
      } else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          result.ahead = Number(match[1]);
          result.behind = Number(match[2]);
        }
      }
      continue;
    }
    const record = token[0] ?? "";
    let entries: ChangedFile[] = [];
    if (record === "1") {
      const parsed = splitFields(token, 8);
      if (parsed) {
        entries = entriesFor(record, parsed.fields[1] ?? "..", parsed.rest, null);
      }
    } else if (record === "2") {
      const parsed = splitFields(token, 9);
      position += 1;
      if (parsed) {
        entries = entriesFor(record, parsed.fields[1] ?? "..", parsed.rest, tokens[position] ?? null);
      }
    } else if (record === "u") {
      const parsed = splitFields(token, 10);
      if (parsed) {
        entries = entriesFor(record, parsed.fields[1] ?? "..", parsed.rest, null);
      }
    } else if (record === "?") {
      entries = entriesFor(record, "??", token.slice(2), null);
    }
    if (entries.length === 0) {
      continue;
    }
    if (records >= limit) {
      result.truncated = true;
      continue;
    }
    records += 1;
    for (const entry of entries) {
      if (entry.path.endsWith("/")) {
        entry.path = entry.path.slice(0, -1);
        entry.directory = true;
      }
      result.files.push(entry);
    }
  }
  return result;
}

export interface NumstatEntry {
  path: string;
  oldPath: string | null;
  additions: number | null;
  deletions: number | null;
}

export function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const tokens = output.split("\0");
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position] ?? "";
    if (!token) {
      continue;
    }
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token);
    if (!match) {
      continue;
    }
    const additions = match[1] === "-" ? null : Number(match[1]);
    const deletions = match[2] === "-" ? null : Number(match[2]);
    if (match[3]) {
      entries.push({ path: match[3], oldPath: null, additions, deletions });
    } else {
      const oldPath = tokens[position + 1] ?? "";
      const newPath = tokens[position + 2] ?? "";
      position += 2;
      entries.push({ path: newPath, oldPath, additions, deletions });
    }
  }
  return entries;
}

interface UntrackedInfo {
  additions: number | null;
  binary: boolean;
  tooLarge: boolean;
  directory: boolean;
}

async function inspectUntrackedFile(filePath: string): Promise<UntrackedInfo> {
  const fileStats = await lstat(filePath).catch(() => undefined);
  if (!fileStats) {
    return { additions: null, binary: false, tooLarge: false, directory: false };
  }
  if (fileStats.isDirectory()) {
    return { additions: null, binary: false, tooLarge: false, directory: true };
  }
  if (fileStats.isSymbolicLink()) {
    return { additions: 1, binary: false, tooLarge: false, directory: false };
  }
  if (!fileStats.isFile()) {
    return { additions: null, binary: true, tooLarge: false, directory: false };
  }
  if (fileStats.size > maximumUntrackedFileBytes) {
    return { additions: null, binary: false, tooLarge: true, directory: false };
  }
  const handle = await open(filePath, "r").catch(() => undefined);
  if (!handle) {
    return { additions: null, binary: false, tooLarge: false, directory: false };
  }
  try {
    const content = await handle.readFile();
    if (content.length > maximumUntrackedFileBytes) {
      return { additions: null, binary: false, tooLarge: true, directory: false };
    }
    if (content.subarray(0, binaryProbeBytes).includes(0)) {
      return { additions: null, binary: true, tooLarge: false, directory: false };
    }
    let lines = 0;
    for (let offset = content.indexOf(10); offset >= 0; offset = content.indexOf(10, offset + 1)) {
      lines += 1;
    }
    if (content.length > 0 && content[content.length - 1] !== 10) {
      lines += 1;
    }
    return { additions: lines, binary: false, tooLarge: false, directory: false };
  } finally {
    await handle.close();
  }
}

export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await operation(item);
      }
    }
  });
  await Promise.all(workers);
}

function applyNumstat(files: readonly ChangedFile[], entries: readonly NumstatEntry[]): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const file of files) {
    if (file.status === "untracked" || file.status === "conflicted") {
      continue;
    }
    const entry = byPath.get(file.path);
    if (!entry) {
      if (!file.directory) {
        file.additions = 0;
        file.deletions = 0;
      }
      continue;
    }
    file.additions = entry.additions;
    file.deletions = entry.deletions;
    file.binary = entry.additions === null && entry.deletions === null;
  }
}

async function readParsedStatus(repo: string, pathspec: readonly string[] = []): Promise<ParsedStatus> {
  const statusResult = await runGit(repo, [
    "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all",
    ...(pathspec.length > 0 ? ["--", ...pathspec] : [])
  ]);
  return parsePorcelainStatus(statusResult.stdout.toString("utf8"));
}

export async function computeStatus(repo: string, scope?: ReadonlySet<string>): Promise<RepositoryStatus> {
  const parsed = await readParsedStatus(repo);
  const repositoryFiles = new Set(parsed.files.map((file) => file.path)).size;
  if (scope) {
    // A rename stays listed when either of its paths is in scope, so a moved file's source is not lost.
    parsed.files = parsed.files.filter((file) => scope.has(file.path) || (file.oldPath !== null && scope.has(file.oldPath)));
  }
  const hasCommits = parsed.oid !== null && parsed.oid !== "(initial)";
  const base = hasCommits ? "HEAD" : emptyTreeObject;
  const staged = parsed.files.filter((file) => file.section === "staged");
  if (staged.length > 0) {
    const numstat = await runGit(repo, [
      "diff", "--cached", base, "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"
    ]);
    applyNumstat(staged, parseNumstat(numstat.stdout.toString("utf8")));
  }
  const unstaged = parsed.files.filter((file) => file.section === "unstaged");
  if (unstaged.some((file) => file.status !== "untracked" && file.status !== "conflicted")) {
    const numstat = await runGit(repo, [
      "diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"
    ]);
    applyNumstat(unstaged, parseNumstat(numstat.stdout.toString("utf8")));
  }
  await mapWithConcurrency(
    parsed.files.filter((file) => file.status === "untracked" && !file.directory),
    untrackedReadConcurrency,
    async (file) => {
      const info = await inspectUntrackedFile(path.join(repo, file.path));
      file.additions = info.additions;
      file.deletions = info.additions === null ? null : 0;
      file.binary = info.binary;
      file.tooLarge = info.tooLarge;
      file.directory = info.directory;
    }
  );
  const totals = { files: new Set(parsed.files.map((file) => file.path)).size, additions: 0, deletions: 0 };
  for (const file of parsed.files) {
    totals.additions += file.additions ?? 0;
    totals.deletions += file.deletions ?? 0;
  }
  const detached = parsed.head === "(detached)";
  return {
    root: repo,
    name: path.basename(repo),
    branch: detached ? null : parsed.head,
    detached,
    headShort: hasCommits && parsed.oid ? parsed.oid.slice(0, 7) : null,
    hasCommits,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    files: parsed.files,
    totals,
    repositoryTotals: { files: repositoryFiles, truncated: parsed.truncated },
    truncated: parsed.truncated
  };
}

const inFlightStatus = new Map<string, Promise<RepositoryStatus>>();

export function readStatus(repo: string, scope?: ReadonlySet<string>): Promise<RepositoryStatus> {
  if (scope) {
    return computeStatus(repo, scope);
  }
  const existing = inFlightStatus.get(repo);
  if (existing) {
    return existing;
  }
  const pending = computeStatus(repo).finally(() => {
    inFlightStatus.delete(repo);
  });
  inFlightStatus.set(repo, pending);
  return pending;
}

export function validateRelativePathSyntax(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
    throw new GitChangesError(400, "A valid repository-relative path is required", "invalid_path");
  }
  if (path.posix.isAbsolute(value) || path.isAbsolute(value)) {
    throw new GitChangesError(400, "File paths must be relative to the repository", "invalid_path");
  }
  let normalized = path.posix.normalize(value);
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new GitChangesError(400, "File paths must stay inside the repository", "invalid_path");
  }
  if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    throw new GitChangesError(400, "Git metadata cannot be read", "invalid_path");
  }
  return normalized;
}

export async function validateRelativePath(repo: string, value: unknown): Promise<string> {
  const normalized = validateRelativePathSyntax(value);
  // The file itself may be deleted, so resolve its nearest existing ancestor instead.
  let ancestor = path.dirname(path.join(repo, normalized));
  while (isWithinOrEqual(repo, ancestor)) {
    const resolved = await realpath(ancestor).catch(() => undefined);
    if (resolved !== undefined) {
      if (!isWithinOrEqual(repo, resolved)) {
        throw new GitChangesError(400, "File paths must stay inside the repository", "invalid_path");
      }
      return normalized;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    ancestor = parent;
  }
  throw new GitChangesError(400, "File paths must stay inside the repository", "invalid_path");
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  section: ChangeSection;
  binary: boolean;
  tooLarge: boolean;
  truncated: boolean;
  directory: boolean;
  additions: number | null;
  deletions: number | null;
  diff: string;
}

export function truncateDiff(output: Buffer, limit = maximumDiffBytes): { text: string; truncated: boolean } {
  if (output.length <= limit) {
    return { text: output.toString("utf8"), truncated: false };
  }
  const head = output.subarray(0, limit);
  let cut = -1;
  for (const marker of ["\n@@ ", "\ndiff --git "]) {
    cut = Math.max(cut, head.lastIndexOf(marker));
  }
  if (cut <= 0) {
    cut = head.lastIndexOf(10);
  }
  return {
    text: head.subarray(0, cut > 0 ? cut + 1 : limit).toString("utf8"),
    truncated: true
  };
}

export async function readFileDiff(
  repo: string,
  relativePath: string,
  options: { oldPath?: string | undefined; context?: number | "full"; section: ChangeSection }
): Promise<FileDiff> {
  const pathspec = options.oldPath && options.oldPath !== relativePath
    ? [relativePath, options.oldPath]
    : [relativePath];
  const parsed = await readParsedStatus(repo, pathspec);
  const file = parsed.files.find((entry) => entry.path === relativePath && entry.section === options.section);
  if (!file) {
    throw new GitChangesError(404, "The file has no uncommitted changes in this section", "file_not_changed");
  }
  const contextLines = options.context === "full"
    ? fullContextLines
    : Math.max(0, Math.min(options.context ?? 3, 1000));
  const response: FileDiff = {
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    section: file.section,
    binary: false,
    tooLarge: false,
    truncated: false,
    directory: file.directory,
    additions: null,
    deletions: null,
    diff: ""
  };

  if (file.status === "untracked") {
    const info = await inspectUntrackedFile(path.join(repo, file.path));
    response.additions = info.additions;
    response.deletions = info.additions === null ? null : 0;
    response.binary = info.binary;
    response.tooLarge = info.tooLarge;
    response.directory = info.directory;
    if (info.tooLarge || info.directory) {
      return response;
    }
    const result = await runGit(repo, [
      "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv",
      `-U${contextLines}`, "--", "/dev/null", file.path
    ], { acceptExitCodes: [0, 1], truncate: true, maxBytes: maximumDiffBytes + 1 });
    const diff = truncateDiff(result.stdout);
    response.diff = diff.text;
    response.truncated = diff.truncated || result.truncated;
    return response;
  }

  if (file.status === "conflicted") {
    return response;
  }
  const base = parsed.oid !== null && parsed.oid !== "(initial)" ? "HEAD" : emptyTreeObject;
  const diffPaths = file.oldPath ? [file.path, file.oldPath] : [file.path];
  // Staged changes compare the index with HEAD; unstaged changes compare the worktree with the index.
  const scope = file.section === "staged" ? ["--cached", base] : [];
  const [numstat, result] = await Promise.all([
    runGit(repo, ["diff", ...scope, "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--", ...diffPaths]),
    runGit(repo, [
      "diff", ...scope, "--no-color", "--no-ext-diff", "--no-textconv", "-M",
      `-U${contextLines}`, "--", ...diffPaths
    ], { truncate: true, maxBytes: maximumDiffBytes + 1 })
  ]);
  const counts = parseNumstat(numstat.stdout.toString("utf8"));
  const entry = counts.find((candidate) => candidate.path === file.path) ?? counts[0];
  if (entry) {
    response.additions = entry.additions;
    response.deletions = entry.deletions;
    response.binary = entry.additions === null && entry.deletions === null;
  } else {
    response.additions = 0;
    response.deletions = 0;
  }
  const diff = truncateDiff(result.stdout);
  response.diff = diff.text;
  response.truncated = diff.truncated || result.truncated;
  if (!response.binary && /^Binary files .* differ$/m.test(response.diff)) {
    response.binary = true;
  }
  return response;
}

export type ChangeStagingAction = "stage" | "unstage";

// Only the Git index changes; the worktree is never modified.
export async function setChangeStaged(
  repo: string,
  relativePath: string,
  action: ChangeStagingAction
): Promise<void> {
  const parsed = await readParsedStatus(repo);
  const section: ChangeSection = action === "stage" ? "unstaged" : "staged";
  const file = parsed.files.find((entry) => entry.path === relativePath && entry.section === section);
  if (!file) {
    throw new GitChangesError(
      409,
      "That file is no longer in this list. Refresh the Changes view and try again.",
      "file_not_changed"
    );
  }
  // Unstaging a rename must restore its source path too, or the deletion would stay staged.
  const args = action === "stage"
    ? ["add", "--all", "--", relativePath]
    : ["reset", "--quiet", "--", ...(file.oldPath ? [relativePath, file.oldPath] : [relativePath])];
  await runIndexCommand(repo, args);
}

// A Git process holding the index makes the command fail with index.lock; report that as busy.
async function runIndexCommand(repo: string, args: readonly string[]): Promise<void> {
  try {
    await runGit(repo, args);
  } catch (error) {
    if (error instanceof GitChangesError && error.message.includes("index.lock")) {
      throw new GitChangesError(409, "Git is busy in this repository. Try again in a moment.", "index_locked");
    }
    throw error;
  }
}

const unresettableFolderMessage = "Folders and nested repositories can't be reset from the Changes panel.";
const resettableStatuses: ReadonlySet<FileChangeStatus> = new Set<FileChangeStatus>([
  "untracked", "added", "modified", "deleted", "typechange"
]);

// Reset discards the unstaged part of one file: tracked files return to their staged or committed version, and new
// files are deleted. Staged changes stay in the index.
export async function resetChangedFile(repo: string, relativePath: string): Promise<void> {
  const parsed = await readParsedStatus(repo, [relativePath]);
  const file = parsed.files.find((entry) => entry.path === relativePath && entry.section === "unstaged");
  if (!file) {
    throw new GitChangesError(
      409,
      "That file is no longer in this list. Refresh the Changes view and try again.",
      "file_not_changed"
    );
  }
  if (file.directory) {
    throw new GitChangesError(409, unresettableFolderMessage, "file_not_resettable");
  }
  if (file.status === "conflicted") {
    throw new GitChangesError(
      409,
      "Conflicted files can't be reset from the Changes panel. Resolve them in your editor first.",
      "file_not_resettable"
    );
  }
  if (!resettableStatuses.has(file.status)) {
    throw new GitChangesError(409, "This kind of change can't be reset from the Changes panel.", "file_not_resettable");
  }
  if (file.status === "untracked") {
    await deleteNewFile(repo, relativePath);
  } else if (file.status === "added") {
    // An intent-to-add entry has no saved content, so the file is new: drop the entry, then delete the file.
    await runIndexCommand(repo, ["reset", "--quiet", "--", relativePath]);
    await deleteNewFile(repo, relativePath);
  } else {
    await runIndexCommand(repo, ["restore", "--worktree", "--", relativePath]);
    // Git leaves some entries alone, such as a submodule whose checkout moved, so confirm that the change is gone.
    const remaining = await readParsedStatus(repo, [relativePath]);
    if (remaining.files.some((entry) => entry.path === relativePath && entry.section === "unstaged")) {
      throw new GitChangesError(
        409,
        "Git still reports changes to this file after the reset. If it is a submodule, reset it in a terminal.",
        "file_not_resettable"
      );
    }
  }
}

// Removes only the entry itself; a symbolic link is unlinked rather than followed.
async function deleteNewFile(repo: string, relativePath: string): Promise<void> {
  const absolutePath = path.join(repo, relativePath);
  const entryStats = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!entryStats) {
    return;
  }
  if (entryStats.isDirectory()) {
    throw new GitChangesError(409, unresettableFolderMessage, "file_not_resettable");
  }
  await unlink(absolutePath);
}
