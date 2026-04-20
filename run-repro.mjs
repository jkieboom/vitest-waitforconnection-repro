import { spawn } from "node:child_process";

const cwd = import.meta.dirname;
const npmExecCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const dropMarker = "[repro-proxy] dropped first tester websocket before handshake";

const control = await runCase({
  name: "control",
  failFirstTesterSocket: false,
  timeoutMs: 20_000,
});

const broken = await runCase({
  name: "broken",
  failFirstTesterSocket: true,
  timeoutMs: 15_000,
});

const success = control.kind === "exit"
  && control.code === 0
  && broken.kind === "timeout"
  && !containsDropMarker(control)
  && containsDropMarker(broken);

console.log("\n=== Summary ===");
console.log(JSON.stringify({ control, broken, success }, null, 2));

if (!success) {
  process.exitCode = 1;
}

async function runCase({ name, failFirstTesterSocket, timeoutMs }) {
  console.log(`\n=== ${name} ===`);

  const child = spawn(
    npmExecCommand,
    ["exec", "--", "vitest", "run", "--config", "./vitest.config.ts"],
    {
      cwd,
      env: {
        ...process.env,
        VITE_REPRO_FAIL_FIRST_TESTER_SOCKET: failFirstTesterSocket ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  const exitResult = await Promise.race([
    new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ kind: "exit", code, signal });
      });
    }),
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ kind: "timeout" });
      }, timeoutMs);
    }),
  ]);

  if (exitResult.kind === "timeout") {
    child.kill("SIGTERM");

    await new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2_000);

      child.once("exit", () => {
        clearTimeout(forceKillTimer);
        resolve(undefined);
      });
    });
  }

  return {
    name,
    timeoutMs,
    failFirstTesterSocket,
    observedDrop: containsDropMarker({ stdout, stderr }),
    stdout,
    stderr,
    ...exitResult,
  };
}

function containsDropMarker(result) {
  return `${result.stdout}\n${result.stderr}`.includes(dropMarker);
}
