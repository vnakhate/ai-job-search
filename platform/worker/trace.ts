import type { TraceEvent } from "@orcareplay/schema";
import type { Run } from "./contracts";
// Events deliberately hold summaries only: profile, prompts, tokens and raw postings
// remain private application state and never enter the downloadable audit trace.
export function event(
  run: Run,
  type: TraceEvent["type"],
  label: string,
  attrs: Record<string, unknown> = {},
) {
  const previous = run.events.at(-1);
  run.events.push({
    seq: run.events.length,
    ts: new Date().toISOString(),
    mono_us: Math.max(
      previous?.mono_us || 0,
      (Date.now() - Date.parse(run.createdAt)) * 1000,
    ),
    turn: run.modelCalls,
    type,
    actor: type.startsWith("model.") ? "model" : "harness",
    attrs: { label, ...attrs },
  });
  run.updatedAt = new Date().toISOString();
}
