import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
// A separate process and temporary storage keep UAT away from the interactive demo.
const state = await mkdtemp(join(tmpdir(), "jobpilot-uat-"));
let child;
let stopping = false;
async function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null) {
    const closed = new Promise((resolve) => child.once("exit", resolve));
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(timer);
  }
  await rm(state, { recursive: true, force: true });
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => void stop(signal));
const build = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
if (build.status !== 0) {
  await stop();
  process.exit(build.status || 1);
}
child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--env",
    "local",
    "--port",
    "8798",
    "--inspector-port",
    "9248",
    "--var",
    "APP_ORIGIN:http://localhost:8798",
    "--persist-to",
    join(state, "storage"),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: join(state, "wrangler.log"),
      WRANGLER_SEND_METRICS: "false",
    },
  },
);
child.once("exit", (code) => {
  if (!stopping)
    void stop().then(() => {
      process.exitCode = code || 1;
    });
});
