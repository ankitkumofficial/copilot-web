import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../cpw-installer/macOS/cpw", import.meta.url));
const installer = fileURLToPath(new URL("../cpw-installer/macOS/install.sh", import.meta.url));
const mockCommands = `
launchctl() {
  printf '%s\\n' "$*" >> "$HOME/launchctl-calls"
  case "$1" in
    print)
      [[ "$(cat "$HOME/service-state")" == loaded ]] || return 1
      printf 'state = running\\npid = 123\\n'
      ;;
    bootout)
      if [[ "$CPW_TEST_FAIL_BOOTOUT" == 1 ]]; then
        echo "mock shutdown failed" >&2
        return 5
      fi
      if [[ "\${2:-}" == --wait ]]; then
        echo unloaded > "$HOME/service-state"
      else
        echo stopping > "$HOME/service-state"
      fi
      ;;
    bootstrap)
      if [[ "$(cat "$HOME/service-state")" != unloaded ]]; then
        echo "mock service is still shutting down" >&2
        return 5
      fi
      echo loaded > "$HOME/service-state"
      ;;
    kickstart) ;;
    *) return 2 ;;
  esac
}
lsof() {
  printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n'
  printf 'node 123 test 1u IPv4 0 0t0 TCP 127.0.0.1:8765\\n'
}
source "$1" "$2"
`;

async function runCpw(action: "restart" | "stop", failBootout = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-cpw-"));
  try {
    const agents = path.join(directory, "Library", "LaunchAgents");
    await mkdir(agents, { recursive: true });
    await writeFile(path.join(agents, "com.github.copilot-web.plist"), `<?xml version="1.0"?>
<plist version="1.0">
<dict>
  <key>WorkingDirectory</key>
  <string>/tmp</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NPM_BIN</key>
    <string>/bin/echo</string>
  </dict>
</dict>
</plist>
`);
    await writeFile(path.join(directory, "service-state"), "loaded\n");
    const result = spawnSync("/bin/bash", [
      "-c", mockCommands, "cpw-test", script, action
    ], {
      env: {
        ...process.env,
        HOME: directory,
        CPW_TEST_FAIL_BOOTOUT: failBootout ? "1" : "0"
      },
      encoding: "utf8",
      timeout: 5_000
    });
    assert.ifError(result.error);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      state: (await readFile(path.join(directory, "service-state"), "utf8")).trim(),
      calls: (await readFile(path.join(directory, "launchctl-calls"), "utf8")).trim().split("\n")
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("cpw restart waits for service removal before bootstrapping its replacement", {
  skip: process.platform !== "darwin"
}, async () => {
  const result = await runCpw("restart");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, "loaded");
  assert.match(result.stdout, /copilot-web restarted on 127\.0\.0\.1:8765/);
});

test("cpw stop reports success only after service removal completes", {
  skip: process.platform !== "darwin"
}, async () => {
  const result = await runCpw("stop");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, "unloaded");
  assert.match(result.stdout, /copilot-web stopped/);
});

test("cpw restart aborts without starting a replacement when shutdown fails", {
  skip: process.platform !== "darwin"
}, async () => {
  const result = await runCpw("restart", true);
  assert.equal(result.status, 5);
  assert.match(result.stderr, /mock shutdown failed/);
  assert.equal(result.state, "loaded");
  assert.equal(result.calls.some((call) => /^(bootstrap|kickstart) /.test(call)), false);
  assert.doesNotMatch(result.stdout, /copilot-web restarted/);
});

test("installed LaunchAgent loads exported zshenv variables on every start without interactive profiles", {
  skip: process.platform !== "darwin"
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-web-installer-"));
  try {
    const app = path.join(directory, "checkout with spaces $HOME");
    const installerDirectory = path.join(app, "cpw-installer", "macOS");
    const bin = path.join(directory, "bin");
    await mkdir(installerDirectory, { recursive: true });
    await mkdir(path.join(app, "node_modules", ".bin"), { recursive: true });
    await mkdir(path.join(app, "dist"));
    await mkdir(bin);
    await copyFile(installer, path.join(installerDirectory, "install.sh"));
    await copyFile(script, path.join(installerDirectory, "cpw"));
    await writeFile(path.join(app, "package.json"), "{}");
    await writeFile(path.join(app, "package-lock.json"), "{}");
    for (const command of [path.join(bin, "npm"), path.join(bin, "copilot"), path.join(app, "node_modules", ".bin", "tsc")]) {
      await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    await writeFile(path.join(app, "dist", "server.js"),
      "process.stdout.write(process.env.CPW_TEST_FROM_ZSHENV ?? 'missing');\n");
    await writeFile(path.join(directory, ".zshenv"), 'export CPW_TEST_FROM_ZSHENV="first value"\n');
    await writeFile(path.join(directory, ".zshrc"), "exit 91\n");
    await writeFile(path.join(directory, ".zprofile"), "exit 92\n");

    const installed = spawnSync("/bin/bash", [path.join(installerDirectory, "install.sh")], {
      env: {
        HOME: directory,
        SHELL: "/bin/zsh",
        PATH: `${directory}/.local/bin:${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        CPW_TEST_FROM_ZSHENV: "installer environment"
      },
      encoding: "utf8",
      timeout: 10_000
    });
    assert.ifError(installed.error);
    assert.equal(installed.status, 0, installed.stderr);

    const configuration = spawnSync("/usr/bin/plutil", [
      "-convert", "json", "-o", "-",
      path.join(directory, "Library", "LaunchAgents", "com.github.copilot-web.plist")
    ], { encoding: "utf8", timeout: 5_000 });
    assert.ifError(configuration.error);
    assert.equal(configuration.status, 0, configuration.stderr);
    const plist: { ProgramArguments: string[]; EnvironmentVariables: Record<string, string> } =
      JSON.parse(configuration.stdout);
    assert.equal(plist.EnvironmentVariables.CPW_TEST_FROM_ZSHENV, undefined);

    for (const value of ["first value", "updated value"]) {
      await writeFile(path.join(directory, ".zshenv"), `export CPW_TEST_FROM_ZSHENV="${value}"\n`);
      const started = spawnSync(plist.ProgramArguments[0]!, plist.ProgramArguments.slice(1), {
        cwd: app,
        env: { HOME: directory, ...plist.EnvironmentVariables },
        encoding: "utf8",
        timeout: 5_000
      });
      assert.ifError(started.error);
      assert.equal(started.status, 0, started.stderr);
      assert.equal(started.stdout, value);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
