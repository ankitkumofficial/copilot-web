import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  type ChangedFile,
  GitChangesError,
  listProjectRepositories,
  maximumDiffBytes,
  parseNumstat,
  parsePorcelainStatus,
  readFileDiff,
  readStatus,
  resetChangedFile,
  resolveToplevel,
  runGit,
  setChangeStaged,
  truncateDiff,
  validateRelativePath,
  validateRelativePathSyntax
} from "./git-changes.js";

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const skipWithoutGit = gitAvailable ? false : "git is not on PATH; git changes tests skipped";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", [
    "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main",
    "-c", "commit.gpgsign=false", ...args
  ], { cwd: repo, encoding: "utf8" });
}

async function temporaryRepository(t: TestContext, commit = true): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "copilot-web-git-test-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = path.join(directory, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  if (commit) {
    await writeFile(path.join(repo, "modified.txt"), "one\ntwo\nthree\n");
    await writeFile(path.join(repo, "deleted.txt"), "gone\n");
    await writeFile(path.join(repo, "renamed-old.txt"), "same content for rename detection\n".repeat(5));
    await writeFile(path.join(repo, "mode.sh"), "echo hi\n");
    await writeFile(path.join(repo, "staged.txt"), "before\n");
    await writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");
  }
  return repo;
}

test("parses porcelain v2 status records and headers", () => {
  const output = [
    "# branch.oid 1234567890abcdef",
    "# branch.head feature/x",
    "# branch.upstream origin/feature/x",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaa aaa src/with space.ts",
    "2 R. N... 100644 100644 100644 aaa aaa R100 new name.ts",
    "old name.ts",
    "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
    "? untracked/",
    "? fresh.ts",
    ""
  ].join("\0");
  const parsed = parsePorcelainStatus(output);
  assert.equal(parsed.head, "feature/x");
  assert.equal(parsed.upstream, "origin/feature/x");
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 1);
  assert.deepEqual(parsed.files.map((file) => [file.path, file.oldPath, file.status, file.section, file.directory]), [
    ["src/with space.ts", null, "modified", "unstaged", false],
    ["new name.ts", "old name.ts", "renamed", "staged", false],
    ["conflict.ts", null, "conflicted", "unstaged", false],
    ["untracked", null, "untracked", "unstaged", true],
    ["fresh.ts", null, "untracked", "unstaged", false]
  ]);
  const limited = parsePorcelainStatus(output, 2);
  assert.equal(limited.files.length, 2);
  assert.equal(limited.truncated, true);
});

test("porcelain records with both staged and unstaged changes yield one entry per section", () => {
  const parsed = parsePorcelainStatus([
    "1 MM N... 100644 100644 100644 aaa bbb partial.ts",
    "1 A. N... 100644 100644 100644 aaa bbb added.ts",
    "1 .D N... 100644 100644 100644 aaa bbb gone.ts",
    ""
  ].join("\0"));
  assert.deepEqual(parsed.files.map((file) => [file.path, file.section, file.status]), [
    ["partial.ts", "staged", "modified"],
    ["partial.ts", "unstaged", "modified"],
    ["added.ts", "staged", "added"],
    ["gone.ts", "unstaged", "deleted"]
  ]);
});

test("parses numstat records including renames and binaries", () => {
  assert.deepEqual(parseNumstat("1\t2\ta.txt\0-\t-\tb.bin\0" + "3\t0\t\0old.txt\0new.txt\0"), [
    { path: "a.txt", oldPath: null, additions: 1, deletions: 2 },
    { path: "b.bin", oldPath: null, additions: null, deletions: null },
    { path: "new.txt", oldPath: "old.txt", additions: 3, deletions: 0 }
  ]);
});

test("truncates diffs at the last complete hunk", () => {
  const hunk = (index: number) => `@@ -${index},1 +${index},1 @@\n-${"a".repeat(40)}\n+${"b".repeat(40)}\n`;
  const text = `diff --git a/x b/x\n--- a/x\n+++ b/x\n${Array.from({ length: 100 }, (_, index) => hunk(index + 1)).join("")}`;
  const result = truncateDiff(Buffer.from(text), 1000);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 1000);
  assert.ok(result.text.endsWith("\n"));
  assert.ok(!result.text.endsWith("@@ \n"));
  const lastHunk = result.text.lastIndexOf("@@ -");
  assert.equal(result.text.slice(lastHunk).split("\n").length, 4);
  assert.deepEqual(truncateDiff(Buffer.from("short")), { text: "short", truncated: false });
});

test("validates repository-relative path syntax", () => {
  assert.equal(validateRelativePathSyntax("src/./a.ts"), "src/a.ts");
  assert.equal(validateRelativePathSyntax("dir/"), "dir");
  assert.equal(validateRelativePathSyntax("back\\slash.txt"), "back\\slash.txt");
  for (const invalid of ["", "/etc/passwd", "../../etc/passwd", "..", ".", "a/../../b", ".git/config", "sub/.GIT/HEAD", "a\0b", 5]) {
    assert.throws(() => validateRelativePathSyntax(invalid), (error: unknown) => (
      error instanceof GitChangesError && error.status === 400 && error.code === "invalid_path"
    ), String(invalid));
  }
});

test("maps a missing git executable to git_unavailable", async () => {
  await assert.rejects(
    runGit(tmpdir(), ["--version"], { command: "git-command-that-does-not-exist" }),
    (error: unknown) => error instanceof GitChangesError && error.status === 503 && error.code === "git_unavailable"
  );
});

test("git status reports every change type with counts", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  await writeFile(path.join(repo, "modified.txt"), "one\nTWO\nthree\nfour\n");
  await rm(path.join(repo, "deleted.txt"));
  git(repo, "mv", "renamed-old.txt", "renamed-new.txt");
  await chmod(path.join(repo, "mode.sh"), 0o755);
  await writeFile(path.join(repo, "staged.txt"), "after\n");
  git(repo, "add", "staged.txt");
  await writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 9, 9, 9]));
  await writeFile(path.join(repo, "neu ü file.txt"), "a\nb");
  await writeFile(path.join(repo, "untracked.bin"), Buffer.from([1, 0, 1]));

  const status = await readStatus(repo);
  assert.equal(status.root, repo);
  assert.equal(status.branch, "main");
  assert.equal(status.hasCommits, true);
  assert.equal(status.detached, false);
  assert.match(status.headShort ?? "", /^[0-9a-f]{7}$/);
  const bySection = new Map(status.files.map((file) => [`${file.section}:${file.path}`, file]));
  assert.deepEqual(
    [...bySection.keys()].sort(),
    [
      "staged:renamed-new.txt", "staged:staged.txt",
      "unstaged:binary.bin", "unstaged:deleted.txt", "unstaged:mode.sh", "unstaged:modified.txt",
      "unstaged:neu ü file.txt", "unstaged:untracked.bin"
    ]
  );
  assert.equal(bySection.get("unstaged:modified.txt")?.status, "modified");
  assert.equal(bySection.get("unstaged:modified.txt")?.additions, 2);
  assert.equal(bySection.get("unstaged:modified.txt")?.deletions, 1);
  assert.equal(bySection.get("unstaged:deleted.txt")?.status, "deleted");
  assert.equal(bySection.get("unstaged:deleted.txt")?.deletions, 1);
  assert.equal(bySection.get("staged:renamed-new.txt")?.status, "renamed");
  assert.equal(bySection.get("staged:renamed-new.txt")?.oldPath, "renamed-old.txt");
  assert.equal(bySection.get("unstaged:mode.sh")?.status, "modified");
  assert.equal(bySection.get("staged:staged.txt")?.status, "modified");
  assert.equal(bySection.get("unstaged:binary.bin")?.binary, true);
  assert.equal(bySection.get("unstaged:neu ü file.txt")?.status, "untracked");
  assert.equal(bySection.get("unstaged:neu ü file.txt")?.additions, 2);
  assert.equal(bySection.get("unstaged:untracked.bin")?.binary, true);
  assert.equal(status.totals.files, 8);
  assert.equal(status.truncated, false);

  const [first, second] = [readStatus(repo), readStatus(repo)];
  assert.equal(first, second, "concurrent status requests share one git invocation");
  await first;
});

test("git diffs cover tracked, untracked, renamed, mode, binary, and full-context files", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  await writeFile(path.join(repo, "modified.txt"), "one\nTWO\nthree\n");
  await rm(path.join(repo, "deleted.txt"));
  await rename(path.join(repo, "renamed-old.txt"), path.join(repo, "renamed-new.txt"));
  git(repo, "add", "-A", "renamed-old.txt", "renamed-new.txt");
  await chmod(path.join(repo, "mode.sh"), 0o755);
  await writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 9, 9, 9]));
  await writeFile(path.join(repo, "spaced name.txt"), "x\ny\n");
  await writeFile(path.join(repo, "empty.txt"), "");

  const modified = await readFileDiff(repo, "modified.txt", { section: "unstaged" });
  assert.equal(modified.status, "modified");
  assert.equal(modified.additions, 1);
  assert.equal(modified.deletions, 1);
  assert.match(modified.diff, /^diff --git a\/modified\.txt b\/modified\.txt/);
  assert.match(modified.diff, /^-two$/m);
  assert.match(modified.diff, /^\+TWO$/m);

  const deleted = await readFileDiff(repo, "deleted.txt", { section: "unstaged" });
  assert.equal(deleted.status, "deleted");
  assert.match(deleted.diff, /^deleted file mode/m);

  const renamed = await readFileDiff(repo, "renamed-new.txt", { oldPath: "renamed-old.txt", section: "staged" });
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.oldPath, "renamed-old.txt");
  assert.match(renamed.diff, /^rename from renamed-old\.txt$/m);
  await assert.rejects(
    readFileDiff(repo, "renamed-new.txt", { section: "unstaged" }),
    (error: unknown) => error instanceof GitChangesError && error.code === "file_not_changed"
  );

  const mode = await readFileDiff(repo, "mode.sh", { section: "unstaged" });
  assert.match(mode.diff, /^old mode 100644$/m);
  assert.match(mode.diff, /^new mode 100755$/m);

  const binary = await readFileDiff(repo, "binary.bin", { section: "unstaged" });
  assert.equal(binary.binary, true);

  const untracked = await readFileDiff(repo, "spaced name.txt", { section: "unstaged" });
  assert.equal(untracked.status, "untracked");
  assert.equal(untracked.additions, 2);
  assert.match(untracked.diff, /^\+\+\+ b\/spaced name\.txt\t?$/m);

  const empty = await readFileDiff(repo, "empty.txt", { section: "unstaged" });
  assert.equal(empty.status, "untracked");
  assert.equal(empty.additions, 0);

  const longLines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  await writeFile(path.join(repo, "long.txt"), `${longLines.join("\n")}\n`);
  git(repo, "add", "long.txt");
  git(repo, "commit", "-qm", "long");
  longLines[20] = "changed";
  await writeFile(path.join(repo, "long.txt"), `${longLines.join("\n")}\n`);
  const shortContext = await readFileDiff(repo, "long.txt", { section: "unstaged" });
  const fullContext = await readFileDiff(repo, "long.txt", { context: "full", section: "unstaged" });
  assert.ok(!shortContext.diff.includes("line 0\n"));
  assert.ok(fullContext.diff.includes(" line 0\n"));

  await assert.rejects(
    readFileDiff(repo, "staged.txt", { section: "unstaged" }),
    (error: unknown) => error instanceof GitChangesError && error.status === 404 && error.code === "file_not_changed"
  );
});

test("git status and diff work in a repository without commits", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t, false);
  await writeFile(path.join(repo, "first.txt"), "hello\n");
  await writeFile(path.join(repo, "staged.txt"), "staged\n");
  git(repo, "add", "staged.txt");
  const status = await readStatus(repo);
  assert.equal(status.hasCommits, false);
  assert.equal(status.headShort, null);
  const byPath = new Map(status.files.map((file) => [file.path, file]));
  assert.equal(byPath.get("first.txt")?.status, "untracked");
  assert.equal(byPath.get("staged.txt")?.status, "added");
  assert.equal(byPath.get("staged.txt")?.additions, 1);
  const diff = await readFileDiff(repo, "staged.txt", { section: "staged" });
  assert.match(diff.diff, /^\+staged$/m);
});

test("git status truncates large untracked listings and diffs stay bounded", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  await mkdir(path.join(repo, "generated"));
  await Promise.all(Array.from({ length: 2_050 }, (_, index) => (
    writeFile(path.join(repo, "generated", `file-${index}.txt`), "x\n")
  )));
  const status = await readStatus(repo);
  assert.equal(status.files.length, 2_000);
  assert.equal(status.truncated, true);

  const big = Array.from({ length: 60_000 }, (_, index) => `line ${index} ${"z".repeat(40)}`).join("\n");
  await writeFile(path.join(repo, "modified.txt"), `${big}\n`);
  const diff = await readFileDiff(repo, "modified.txt", { section: "unstaged" });
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.diff) <= maximumDiffBytes);
  assert.equal(diff.additions, 60_000);

  await writeFile(path.join(repo, "huge-untracked.txt"), "y".repeat(3 * 1024 * 1024));
  const huge = await readFileDiff(repo, "huge-untracked.txt", { section: "unstaged" });
  assert.equal(huge.tooLarge, true);
  assert.equal(huge.diff, "");
});

test("relative path validation rejects symlink escapes", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  const outside = path.join(path.dirname(repo), "outside");
  await mkdir(outside);
  await symlink(outside, path.join(repo, "escape"));
  assert.equal(await validateRelativePath(repo, "modified.txt"), "modified.txt");
  assert.equal(await validateRelativePath(repo, "missing/dir/file.txt"), "missing/dir/file.txt");
  await assert.rejects(validateRelativePath(repo, "escape/secret.txt"), (error: unknown) => (
    error instanceof GitChangesError && error.code === "invalid_path"
  ));
});

test("resolves toplevels and lists project repositories", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  const projects = path.dirname(repo);
  await mkdir(path.join(repo, "nested", "deeper"), { recursive: true });
  await mkdir(path.join(projects, "plain"));
  assert.equal(await resolveToplevel(path.join(repo, "nested", "deeper")), repo);
  assert.equal(await resolveToplevel(path.join(projects, "plain")), undefined);
  assert.deepEqual(await listProjectRepositories(projects), [{ root: repo, name: "repo", relativePath: "repo" }]);
});

test("lists nested repositories below folders, skipping hidden, dependency, and repository-internal folders", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  const projects = path.dirname(repo);
  const below = (...segments: string[]) => path.join(projects, ...segments);
  for (const directory of [
    below("team", "api"),
    below("team", "group", "service"),
    below("team", "group", "deep", "leaf"),
    below("team", "node_modules", "pkg"),
    below(".hidden", "inner")
  ]) {
    await mkdir(directory, { recursive: true });
    git(directory, "init", "-q");
  }
  await mkdir(below("team", "api", "vendored"), { recursive: true });
  git(below("team", "api", "vendored"), "init", "-q");
  await mkdir(below("team", "plain", "sub"), { recursive: true });
  await symlink(repo, below("linked"));

  assert.deepEqual(await listProjectRepositories(projects), [
    { root: repo, name: "repo", relativePath: "repo" },
    { root: below("team", "api"), name: "api", relativePath: "team/api" },
    { root: below("team", "group", "service"), name: "service", relativePath: "team/group/service" }
  ]);
});

const entryKeys = (files: readonly ChangedFile[]): string[] => files.map((file) => `${file.section}:${file.path}`).sort();

test("stages and unstages whole files through the index without touching the worktree", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  await writeFile(path.join(repo, "modified.txt"), "one\nTWO\nthree\n");
  await rm(path.join(repo, "deleted.txt"));
  await writeFile(path.join(repo, "fresh.txt"), "fresh\n");

  await setChangeStaged(repo, "modified.txt", "stage");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), [
    "staged:modified.txt", "unstaged:deleted.txt", "unstaged:fresh.txt"
  ]);
  await setChangeStaged(repo, "modified.txt", "unstage");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), [
    "unstaged:deleted.txt", "unstaged:fresh.txt", "unstaged:modified.txt"
  ]);

  await setChangeStaged(repo, "deleted.txt", "stage");
  const stagedDeletion = (await readStatus(repo)).files.find((file) => file.path === "deleted.txt");
  assert.equal(stagedDeletion?.section, "staged");
  assert.equal(stagedDeletion?.status, "deleted");
  await setChangeStaged(repo, "deleted.txt", "unstage");
  assert.equal((await readStatus(repo)).files.find((file) => file.path === "deleted.txt")?.section, "unstaged");

  await setChangeStaged(repo, "fresh.txt", "stage");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), [
    "staged:fresh.txt", "unstaged:deleted.txt", "unstaged:modified.txt"
  ]);
  await setChangeStaged(repo, "fresh.txt", "unstage");

  await assert.rejects(setChangeStaged(repo, "mode.sh", "stage"), (error: unknown) => (
    error instanceof GitChangesError && error.status === 409 && error.code === "file_not_changed"
  ));
  await assert.rejects(setChangeStaged(repo, "modified.txt", "unstage"), (error: unknown) => (
    error instanceof GitChangesError && error.status === 409 && error.code === "file_not_changed"
  ));
  assert.equal(await readFile(path.join(repo, "modified.txt"), "utf8"), "one\nTWO\nthree\n");
  assert.equal(await readFile(path.join(repo, "fresh.txt"), "utf8"), "fresh\n");
  await assert.rejects(readFile(path.join(repo, "deleted.txt")), { code: "ENOENT" });
});

test("partially staged files appear in both sections with separate diffs and staging", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  await writeFile(path.join(repo, "modified.txt"), "one\nTWO\nthree\n");
  git(repo, "add", "modified.txt");
  await writeFile(path.join(repo, "modified.txt"), "one\nTWO\nthree\nfour\n");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["staged:modified.txt", "unstaged:modified.txt"]);

  const stagedDiff = await readFileDiff(repo, "modified.txt", { section: "staged" });
  assert.match(stagedDiff.diff, /^\+TWO$/m);
  assert.doesNotMatch(stagedDiff.diff, /^\+four$/m);
  const unstagedDiff = await readFileDiff(repo, "modified.txt", { section: "unstaged" });
  assert.match(unstagedDiff.diff, /^\+four$/m);
  assert.doesNotMatch(unstagedDiff.diff, /^\+TWO$/m);

  await setChangeStaged(repo, "modified.txt", "stage");
  const merged = (await readStatus(repo)).files;
  assert.deepEqual(entryKeys(merged), ["staged:modified.txt"]);
  assert.equal(merged[0]?.additions, 2);
  assert.equal(merged[0]?.deletions, 1);

  await writeFile(path.join(repo, "modified.txt"), "one\nTWO\nthree\nfour\nfive\n");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["staged:modified.txt", "unstaged:modified.txt"]);
  await setChangeStaged(repo, "modified.txt", "unstage");
  const unstaged = (await readStatus(repo)).files;
  assert.deepEqual(entryKeys(unstaged), ["unstaged:modified.txt"]);
  assert.equal(unstaged[0]?.additions, 3);
  assert.equal(unstaged[0]?.deletions, 1);
});

test("unstaging a staged rename restores its source as a deletion and staging again re-detects it", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  git(repo, "mv", "renamed-old.txt", "renamed-new.txt");

  await setChangeStaged(repo, "renamed-new.txt", "unstage");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["unstaged:renamed-new.txt", "unstaged:renamed-old.txt"]);

  await setChangeStaged(repo, "renamed-new.txt", "stage");
  await setChangeStaged(repo, "renamed-old.txt", "stage");
  const [renamed] = (await readStatus(repo)).files;
  assert.equal(renamed?.section, "staged");
  assert.equal(renamed?.status, "renamed");
  assert.equal(renamed?.path, "renamed-new.txt");
  assert.equal(renamed?.oldPath, "renamed-old.txt");
});

test("stages and unstages files in a repository without commits", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t, false);
  await writeFile(path.join(repo, "first.txt"), "hello\n");

  await setChangeStaged(repo, "first.txt", "stage");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["staged:first.txt"]);
  await setChangeStaged(repo, "first.txt", "unstage");
  const [file] = (await readStatus(repo)).files;
  assert.equal(file?.section, "unstaged");
  assert.equal(file?.status, "untracked");
});

test("conflicted files can be marked resolved by staging but are never unstaged", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  git(repo, "checkout", "-q", "-b", "other");
  await writeFile(path.join(repo, "modified.txt"), "other\n");
  git(repo, "commit", "-qam", "other");
  git(repo, "checkout", "-q", "main");
  await writeFile(path.join(repo, "modified.txt"), "main\n");
  git(repo, "commit", "-qam", "main");
  assert.throws(() => git(repo, "merge", "--no-edit", "other"));

  const conflicted = (await readStatus(repo)).files.find((file) => file.path === "modified.txt");
  assert.equal(conflicted?.status, "conflicted");
  assert.equal(conflicted?.section, "unstaged");
  assert.equal((await readFileDiff(repo, "modified.txt", { section: "unstaged" })).diff, "");
  await assert.rejects(setChangeStaged(repo, "modified.txt", "unstage"), (error: unknown) => (
    error instanceof GitChangesError && error.status === 409 && error.code === "file_not_changed"
  ));

  await setChangeStaged(repo, "modified.txt", "stage");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["staged:modified.txt"]);
});

test("rejects stale stage requests and reports a busy index without changing anything", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  await writeFile(path.join(repo, "modified.txt"), "changed\n");
  await writeFile(path.join(repo, ".git", "index.lock"), "");
  try {
    await assert.rejects(setChangeStaged(repo, "modified.txt", "stage"), (error: unknown) => (
      error instanceof GitChangesError && error.status === 409 && error.code === "index_locked"
    ));
  } finally {
    await rm(path.join(repo, ".git", "index.lock"), { force: true });
  }
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["unstaged:modified.txt"]);
  await setChangeStaged(repo, "modified.txt", "stage");
  await assert.rejects(setChangeStaged(repo, "modified.txt", "stage"), (error: unknown) => (
    error instanceof GitChangesError && error.status === 409 && error.code === "file_not_changed"
  ));
});

test("resets unstaged changes per file, keeps staged changes, and deletes new files", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  await writeFile(path.join(repo, "modified.txt"), "one\nTWO\nthree\n");
  await rm(path.join(repo, "deleted.txt"));
  await rm(path.join(repo, "mode.sh"));
  await symlink("modified.txt", path.join(repo, "mode.sh"));
  await writeFile(path.join(repo, "staged.txt"), "staged\n");
  git(repo, "add", "staged.txt");
  await writeFile(path.join(repo, "staged.txt"), "staged\nunstaged\n");
  await writeFile(path.join(repo, "fresh.txt"), "fresh\n");
  await writeFile(path.join(repo, "intent.txt"), "intent\n");
  git(repo, "add", "--intent-to-add", "intent.txt");
  await mkdir(path.join(repo, "nested"));
  git(path.join(repo, "nested"), "init", "-q");
  await writeFile(path.join(repo, "nested", "x.txt"), "x\n");
  const before = (await readStatus(repo)).files;
  assert.deepEqual(entryKeys(before), [
    "staged:staged.txt", "unstaged:deleted.txt", "unstaged:fresh.txt", "unstaged:intent.txt",
    "unstaged:mode.sh", "unstaged:modified.txt", "unstaged:nested", "unstaged:staged.txt"
  ]);
  assert.equal(before.find((file) => file.path === "mode.sh")?.status, "typechange");

  await resetChangedFile(repo, "modified.txt");
  assert.equal(await readFile(path.join(repo, "modified.txt"), "utf8"), "one\ntwo\nthree\n");
  await resetChangedFile(repo, "deleted.txt");
  assert.equal(await readFile(path.join(repo, "deleted.txt"), "utf8"), "gone\n");
  await resetChangedFile(repo, "mode.sh");
  assert.equal(await readFile(path.join(repo, "mode.sh"), "utf8"), "echo hi\n");
  await resetChangedFile(repo, "staged.txt");
  assert.equal(await readFile(path.join(repo, "staged.txt"), "utf8"), "staged\n");
  await resetChangedFile(repo, "fresh.txt");
  await resetChangedFile(repo, "intent.txt");
  await assert.rejects(readFile(path.join(repo, "fresh.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(repo, "intent.txt")), { code: "ENOENT" });
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["staged:staged.txt", "unstaged:nested"]);

  await assert.rejects(resetChangedFile(repo, "nested"), (error: unknown) => (
    error instanceof GitChangesError && error.status === 409 && error.code === "file_not_resettable"
  ));
  assert.equal(await readFile(path.join(repo, "nested", "x.txt"), "utf8"), "x\n");
  await assert.rejects(resetChangedFile(repo, "staged.txt"), (error: unknown) => (
    error instanceof GitChangesError && error.status === 409 && error.code === "file_not_changed"
  ));
  await assert.rejects(resetChangedFile(repo, "binary.bin"), (error: unknown) => (
    error instanceof GitChangesError && error.status === 409 && error.code === "file_not_changed"
  ));
  assert.equal(await readFile(path.join(repo, "staged.txt"), "utf8"), "staged\n");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["staged:staged.txt", "unstaged:nested"]);
});

test("resets new files in a repository without commits", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t, false);
  await writeFile(path.join(repo, "first.txt"), "hello\n");
  await writeFile(path.join(repo, "second.txt"), "world\n");
  git(repo, "add", "--intent-to-add", "second.txt");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["unstaged:first.txt", "unstaged:second.txt"]);

  await resetChangedFile(repo, "second.txt");
  await resetChangedFile(repo, "first.txt");
  await assert.rejects(readFile(path.join(repo, "first.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(repo, "second.txt")), { code: "ENOENT" });
  assert.deepEqual((await readStatus(repo)).files, []);
});

test("refuses to reset conflicted files, which must be resolved first", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  git(repo, "checkout", "-q", "-b", "other");
  await writeFile(path.join(repo, "modified.txt"), "other\n");
  git(repo, "commit", "-qam", "other");
  git(repo, "checkout", "-q", "main");
  await writeFile(path.join(repo, "modified.txt"), "main\n");
  git(repo, "commit", "-qam", "main");
  assert.throws(() => git(repo, "merge", "--no-edit", "other"));

  await assert.rejects(resetChangedFile(repo, "modified.txt"), (error: unknown) => (
    error instanceof GitChangesError && error.status === 409 && error.code === "file_not_resettable"
  ));
  assert.match(await readFile(path.join(repo, "modified.txt"), "utf8"), /^<<<<<<< /m);
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["unstaged:modified.txt"]);
});

test("refuses to reset a submodule that Git leaves modified", { skip: skipWithoutGit }, async (t) => {
  const repo = await temporaryRepository(t);
  const source = await temporaryRepository(t);
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "lib");
  git(repo, "commit", "-qm", "add submodule");
  git(path.join(repo, "lib"), "commit", "-q", "--allow-empty", "-m", "moved");
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["unstaged:lib"]);

  await assert.rejects(resetChangedFile(repo, "lib"), (error: unknown) => (
    error instanceof GitChangesError && error.status === 409 && error.code === "file_not_resettable"
  ));
  assert.deepEqual(entryKeys((await readStatus(repo)).files), ["unstaged:lib"]);
});
