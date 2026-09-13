import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { TraceWriter } from "@orcareplay/core";
import { assertEvent } from "@orcareplay/schema";
import { pathToFileURL } from "node:url";
export async function exportAudit(input, output) {
  if (
    input.format !== "jobpilot-audit-v1" ||
    !/^run_[a-f0-9]{32}$/.test(input.runId) ||
    !Array.isArray(input.events)
  )
    throw new Error("Not a JobPilot audit export");
  if (!["completed", "cancelled"].includes(input.status))
    throw new Error(
      "Finish or cancel the run before exporting a sealed Orca trace",
    );
  input.events.forEach((e, i) => {
    assertEvent(e);
    if (e.seq !== i) throw new Error("Non-contiguous audit sequence");
  });
  if (
    input.events[0]?.type !== "run.start" ||
    input.events.at(-1)?.type !== "run.end" ||
    input.events.filter((e) => e.type === "run.start" || e.type === "run.end")
      .length !== 2
  )
    throw new Error("Invalid run boundaries");
  // Refuse to overwrite an existing trace. Core supplies redaction, blob spilling,
  // content hashes, manifest validation and private filesystem permissions.
  await mkdir(resolve(output, input.runId), { recursive: false, mode: 0o700 });
  const writer = await TraceWriter.create(output, {
    runId: input.runId,
    adapter: { id: "jobpilot-audit", version: "0.1.0" },
    argv: [],
    cwd: ".",
    orcaVersion: "0.2.4",
    envAllowlist: [],
  });
  for (const e of input.events)
    await writer.append({
      type: e.type,
      actor: e.actor,
      turn: e.turn,
      attrs: {
        ...e.attrs,
        original_ts: e.ts,
        original_mono_us: e.mono_us,
        audit_only: true,
      },
    });
  await writer.close(input.status === "completed" ? 0 : 1);
  return writer.runDir;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const file = process.argv[2];
  if (!file)
    throw new Error(
      "Usage: npm run orca:export -- run.json [output directory]",
    );
  const output = resolve(process.argv[3] || ".orca/runs");
  await mkdir(output, { recursive: true, mode: 0o700 });
  console.log(
    await exportAudit(JSON.parse(await readFile(file, "utf8")), output),
  );
  console.log(
    "Audit trace exported. Inspect with Orca show/export. Execution replay is not supported.",
  );
}
