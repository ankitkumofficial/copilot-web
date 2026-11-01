import { constants as fsConstants } from "node:fs";
import { access, chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { WebSocketServer } from "ws";

import type { MirrorFactory, PtyProcess, PtySpawn } from "./terminal.js";

export interface TerminalRuntime {
  spawn: PtySpawn;
  createMirror: MirrorFactory;
  WebSocketServer: typeof WebSocketServer;
  // Browser URL to absolute file path. Only these files are served from node_modules.
  vendorFiles: ReadonlyMap<string, string>;
}

const requireFromHere = createRequire(import.meta.url);
const selfTestTimeoutMs = 2_000;

export const vendorModules = new Map([
  ["/vendor/xterm/xterm.mjs", "@xterm/xterm/lib/xterm.mjs"],
  ["/vendor/xterm/xterm.css", "@xterm/xterm/css/xterm.css"],
  ["/vendor/xterm/addon-fit.mjs", "@xterm/addon-fit/lib/addon-fit.mjs"],
  ["/vendor/xterm/addon-web-links.mjs", "@xterm/addon-web-links/lib/addon-web-links.mjs"]
]);

interface NodePtyModule {
  spawn(file: string, args: string[], options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  }): PtyProcess;
}

// npm can install node-pty's spawn-helper without the execute bit, which makes every spawn fail with
// "posix_spawnp failed". Restoring the bit is harmless when it is already set.
async function ensureSpawnHelpersExecutable(packageDirectory: string, log: (message: string) => void): Promise<void> {
  const candidates = [
    path.join(packageDirectory, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    path.join(packageDirectory, "build", "Release", "spawn-helper")
  ];
  for (const file of candidates) {
    const present = await stat(file).then((info) => info.isFile(), () => false);
    if (!present || await access(file, fsConstants.X_OK).then(() => true, () => false)) {
      continue;
    }
    try {
      await chmod(file, 0o755);
    } catch {
      throw new Error(`${file} is not executable; run: chmod +x ${file}`);
    }
    log(`[terminal] made node-pty spawn-helper executable: ${file}`);
  }
}

function selfTest(pty: NodePtyModule): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: PtyProcess;
    try {
      child = pty.spawn("/bin/sh", ["-c", "exit 0"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: os.homedir(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" }
      });
    } catch (error) {
      reject(new Error(`node-pty self-test failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The probe already exited.
      }
      reject(new Error("node-pty self-test timed out"));
    }, selfTestTimeoutMs);
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`node-pty self-test exited with code ${exitCode}`));
      }
    });
  });
}

export function vendorFileContentType(file: string): string {
  return file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
}

// Loads optional native and runtime packages. Throws with a short reason when the terminal cannot run.
export async function loadTerminalRuntime(log: (message: string) => void): Promise<TerminalRuntime> {
  const ptyPackageFile = requireFromHere.resolve("node-pty/package.json");
  await ensureSpawnHelpersExecutable(path.dirname(ptyPackageFile), log);
  const pty = requireFromHere("node-pty") as NodePtyModule;
  await selfTest(pty);

  const headlessModule = await import("@xterm/headless");
  const serializeModule = await import("@xterm/addon-serialize");
  const { Terminal: HeadlessTerminal } = headlessModule.default;
  const { SerializeAddon } = serializeModule.default;
  const { WebSocketServer: WebSocketServerClass } = await import("ws");

  const vendorFiles = new Map<string, string>();
  for (const [url, modulePath] of vendorModules) {
    vendorFiles.set(url, requireFromHere.resolve(modulePath));
  }

  return {
    spawn: (file, args, options) => pty.spawn(file, args, options),
    createMirror: ({ cols, rows, scrollback }) => {
      const terminal = new HeadlessTerminal({ cols, rows, scrollback, allowProposedApi: true });
      const serializer = new SerializeAddon();
      terminal.loadAddon(serializer);
      return {
        write: (data, callback) => terminal.write(data, callback),
        resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
        serialize: () => serializer.serialize(),
        onTitleChange: (listener) => {
          terminal.onTitleChange(listener);
        },
        dispose: () => terminal.dispose()
      };
    },
    WebSocketServer: WebSocketServerClass,
    vendorFiles
  };
}
