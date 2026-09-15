#!/usr/bin/env python3
"""Import a JobPilot handoff bundle into job_scraper/seen_jobs.json.

JobPilot (platform/) finds and triages postings in a browser; the slash
commands in this repository apply to them. Until now nothing connected the
two: an approved run stayed in the hosted app. The Worker's
`GET /api/runs/<id>/handoff` route (the web UI's "Export for /apply" button)
exports a `jobpilot-handoff-v1` bundle, and this tool lands its postings in
the seen-jobs file so `/rank` scores them as new candidates and `/scrape`
dedupes against them.

What it writes, all inside the schema `/scrape` Step 4 already documents:

  * the key from tools/job_key.py (never an ad-hoc slug), status `new`,
    `first_seen` today, `posted_date` from the posting's own date, `deadline`
    null (the bundle carries none - never guessed), `portal: jobpilot`,
    `source: jobpilot`
  * a `fit` band derived from JobPilot's score and gates: a FAIL on either
    gate is low; PASS work rights with a score of 75 or more is high; a score
    of 45 or more is medium (including UNVERIFIED work rights, which need
    research before drafting); anything else is low
  * a `jobpilot` provenance object (run id, score, gates, decision), additive
    like `/rank`'s own fields

Postings already present by URL (under any key) or by key are skipped and
reported, never overwritten - dedup is the whole point of the file. Existing
entries are not touched. The candidate profile is not in the bundle and is
never written here.

Usage:
  python3 tools/import_jobpilot.py run_<id>-handoff.json [--dry-run]

Prints JSON on stdout. Exit 0 on success, 1 when the file is not a handoff
bundle or the state file cannot be read.
"""

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from job_key import make_key  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "job_scraper" / "seen_jobs.json"
FORMAT = "jobpilot-handoff-v1"
ISO_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def fit_band(evaluation: dict) -> str:
    score = evaluation.get("score")
    eligibility = evaluation.get("eligibility")
    if evaluation.get("language") == "FAIL" or eligibility == "FAIL":
        return "low"
    if not isinstance(score, (int, float)):
        return "low"
    if score >= 75 and eligibility == "PASS":
        return "high"
    if score >= 45:
        return "medium"
    return "low"


def posted_date(value) -> str | None:
    """The posting's own date as YYYY-MM-DD; anything unparseable is null."""
    if not isinstance(value, str):
        return None
    match = ISO_DATE.match(value.strip())
    if not match:
        return None
    try:
        return date.fromisoformat(match.group(1)).isoformat()
    except ValueError:
        return None


def load_bundle(path: Path) -> dict:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"cannot read {path}: {exc}")
    if not isinstance(doc, dict) or doc.get("format") != FORMAT or not isinstance(doc.get("jobs"), list):
        sys.exit(f"{path} is not a JobPilot handoff bundle (expected format {FORMAT})")
    return doc


def load_state(path: Path) -> tuple[dict, dict]:
    if not path.is_file():
        doc = {"seen": {}}
        return doc, doc["seen"]
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"cannot read {path}: {exc}")
    seen = doc.get("seen") if isinstance(doc, dict) and "seen" in doc else doc
    if not isinstance(seen, dict):
        sys.exit(f"{path}: expected an object of job entries")
    return doc, seen


def save_state(path: Path, doc: dict) -> None:
    """Atomic replace, as tools/rank_state.py does: a half-written file loses the scrape history."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".seen_jobs.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def import_bundle(bundle: dict, seen: dict, today: str) -> tuple[list, list]:
    imported, skipped = [], []
    known_urls = {(e.get("url") or "").rstrip("/") for e in seen.values() if isinstance(e, dict)}
    known_urls.discard("")
    for raw in bundle["jobs"]:
        if not isinstance(raw, dict):
            continue
        job_id = str(raw.get("id", ""))
        evaluation = raw.get("evaluation")
        if not isinstance(evaluation, dict):
            skipped.append({"id": job_id, "reason": "no evaluation"})
            continue
        company, title, url = str(raw.get("company") or ""), str(raw.get("title") or ""), str(raw.get("url") or "")
        key = make_key(company, title, url)
        if url.rstrip("/") in known_urls:
            skipped.append({"id": job_id, "key": key, "reason": "url already in seen_jobs.json"})
            continue
        if key in seen:
            skipped.append({"id": job_id, "key": key, "reason": "key already in seen_jobs.json"})
            continue
        entry = {
            "title": title,
            "company": company,
            "url": url,
            "location": raw.get("location") or "",
            "first_seen": today,
            "posted_date": posted_date(raw.get("date")),
            "deadline": None,
            "fit": fit_band(evaluation),
            "status": "new",
            "portal": "jobpilot",
            "source": "jobpilot",
            "jobpilot": {
                "run_id": bundle.get("runId"),
                "score": evaluation.get("score"),
                "eligibility": evaluation.get("eligibility"),
                "language": evaluation.get("language"),
                "decision": raw.get("decision"),
            },
        }
        seen[key] = entry
        known_urls.add(url.rstrip("/"))
        imported.append({"key": key, "title": title, "company": company, "fit": entry["fit"]})
    return imported, skipped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("bundle", help="run_<id>-handoff.json downloaded from JobPilot")
    ap.add_argument("--state", default=str(STATE), help=argparse.SUPPRESS)
    ap.add_argument("--today", default=date.today().isoformat(), help=argparse.SUPPRESS)
    ap.add_argument("--dry-run", action="store_true", help="report what would change, write nothing")
    args = ap.parse_args()

    bundle = load_bundle(Path(args.bundle))
    state_path = Path(args.state)
    doc, seen = load_state(state_path)
    imported, skipped = import_bundle(bundle, seen, args.today)
    if imported and not args.dry_run:
        save_state(state_path, doc)
    print(json.dumps({
        "run_id": bundle.get("runId"),
        "state": str(state_path),
        "dry_run": args.dry_run,
        "imported": imported,
        "skipped": skipped,
        "next": "run /rank to score the new candidates, or /apply <url> on one directly",
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
