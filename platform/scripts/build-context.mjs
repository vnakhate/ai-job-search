import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
// Methodology only. Never bundle CLAUDE.md, private profiles or personal documents.
const paths = [
  ".claude/skills/job-application-assistant/04-job-evaluation.md",
  ".claude/skills/job-application-assistant/03-writing-style.md",
];
const documents = await Promise.all(
  paths.map(async (path) => ({
    path,
    text: await readFile(new URL("../../" + path, import.meta.url), "utf8"),
  })),
);
const hash = createHash("sha256")
  .update(JSON.stringify(documents))
  .digest("hex");
await writeFile(
  new URL("../worker/context.generated.json", import.meta.url),
  JSON.stringify({ hash, documents }),
);
console.log("Compiled canonical methodology context:", hash.slice(0, 12));
