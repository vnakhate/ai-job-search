"""Tests for tools/import_jobpilot.py - the bridge from a JobPilot run into
the local workflow.

JobPilot (platform/) finds and triages postings; the slash commands apply.
Nothing connected them: an approved run died in the browser. The Worker now
exports a `jobpilot-handoff-v1` bundle and this tool lands its postings in
job_scraper/seen_jobs.json under the canonical tools/job_key.py key, so
`/rank` picks them up as new candidates and `/scrape` dedupes against them.
These pin the contract: canonical keys, the fit band derived from JobPilot's
score and gates, duplicate skipping by URL or key, format rejection, a
missing state file, dry runs, and that nothing else in the file is touched.
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
TOOL = REPO / "tools" / "import_jobpilot.py"
sys.path.insert(0, str(REPO / "tools"))
from job_key import make_key  # noqa: E402

TODAY = "2026-09-14"
RUN = "run_" + "a" * 32


def job(id, title, company, score, eligibility="PASS", language="PASS", **over):
    base = {
        "id": id,
        "title": title,
        "company": company,
        "location": "Remote",
        "url": f"https://example.com/jobs/{id}",
        "date": "2026-09-10T08:00:00.000Z",
        "description": f"Posting text for {title}",
        "evaluation": {
            "score": score,
            "eligibility": eligibility,
            "language": language,
            "reason": "r",
            "evidence": ["Posting text"],
            "gaps": [],
        },
        "decision": "approved" if score >= 45 and eligibility == "PASS" else "rejected",
    }
    base.update(over)
    return base


def handoff(jobs, **over):
    base = {
        "format": "jobpilot-handoff-v1",
        "runId": RUN,
        "exportedAt": "2026-09-14T10:00:00.000Z",
        "status": "completed",
        "query": "Platform Engineer",
        "jobs": jobs,
        "scope": "test",
    }
    base.update(over)
    return base


class ImportJobPilotCase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.state = self.tmp / "seen_jobs.json"
        self.bundle = self.tmp / "handoff.json"
        self.addCleanup(self._tmp.cleanup)

    def write_bundle(self, doc):
        self.bundle.write_text(json.dumps(doc), encoding="utf-8")

    def write_state(self, seen):
        self.state.write_text(json.dumps({"seen": seen}), encoding="utf-8")

    def run_tool(self, *args, expect=0):
        proc = subprocess.run(
            [sys.executable, str(TOOL), str(self.bundle), "--state", str(self.state), "--today", TODAY, *args],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, expect, proc.stderr + proc.stdout)
        return proc

    def read_state(self):
        return json.loads(self.state.read_text(encoding="utf-8"))["seen"]

    def test_imports_postings_under_canonical_keys_with_provenance(self):
        self.write_bundle(handoff([job("j1", "Platform Engineer", "Example Labs", 88)]))
        out = json.loads(self.run_tool().stdout)
        key = make_key("Example Labs", "Platform Engineer", "https://example.com/jobs/j1")
        self.assertEqual([e["key"] for e in out["imported"]], [key])
        entry = self.read_state()[key]
        self.assertEqual(entry["title"], "Platform Engineer")
        self.assertEqual(entry["company"], "Example Labs")
        self.assertEqual(entry["url"], "https://example.com/jobs/j1")
        self.assertEqual(entry["location"], "Remote")
        self.assertEqual(entry["first_seen"], TODAY)
        self.assertEqual(entry["posted_date"], "2026-09-10")
        self.assertIsNone(entry["deadline"])
        self.assertEqual(entry["status"], "new")
        self.assertEqual(entry["portal"], "jobpilot")
        self.assertEqual(entry["source"], "jobpilot")
        self.assertEqual(
            entry["jobpilot"],
            {"run_id": RUN, "score": 88, "eligibility": "PASS", "language": "PASS", "decision": "approved"},
        )

    def test_fit_band_follows_score_and_gates(self):
        self.write_bundle(handoff([
            job("hi", "Strong Role", "A", 88),
            job("mid", "Middling Role", "B", 60, language="FLAG"),
            job("unv", "Unverified Rights", "C", 90, eligibility="UNVERIFIED"),
            job("low", "Weak Role", "D", 30),
            job("fail", "Blocked Role", "E", 0, eligibility="FAIL", language="FAIL"),
        ]))
        self.run_tool()
        fits = {e["title"]: e["fit"] for e in self.read_state().values()}
        self.assertEqual(fits, {
            "Strong Role": "high",
            "Middling Role": "medium",
            "Unverified Rights": "medium",
            "Weak Role": "low",
            "Blocked Role": "low",
        })

    def test_skips_postings_already_seen_by_url_or_key(self):
        existing_key = make_key("Example Labs", "Platform Engineer", "https://example.com/jobs/j1")
        self.write_state({
            "legacy_acme-soc-analyst": {"title": "SOC Analyst", "company": "Acme", "url": "https://example.com/jobs/j2", "status": "skipped"},
            existing_key: {"title": "Platform Engineer", "company": "Example Labs", "url": "https://other.example/x", "status": "ranked"},
        })
        self.write_bundle(handoff([
            job("j1", "Platform Engineer", "Example Labs", 88),
            job("j2", "SOC Analyst", "Acme", 70),
            job("j3", "New Role", "Fresh Co", 70),
        ]))
        out = json.loads(self.run_tool().stdout)
        self.assertEqual([e["key"] for e in out["imported"]], [make_key("Fresh Co", "New Role", "https://example.com/jobs/j3")])
        reasons = {s["id"]: s["reason"] for s in out["skipped"]}
        self.assertEqual(reasons["j1"], "key already in seen_jobs.json")
        self.assertEqual(reasons["j2"], "url already in seen_jobs.json")
        seen = self.read_state()
        self.assertEqual(seen[existing_key]["status"], "ranked")
        self.assertEqual(seen["legacy_acme-soc-analyst"]["status"], "skipped")
        self.assertEqual(len(seen), 3)

    def test_rejects_a_document_that_is_not_a_handoff(self):
        self.write_bundle({"format": "jobpilot-audit-v1", "runId": RUN, "events": []})
        proc = self.run_tool(expect=1)
        self.assertIn("not a JobPilot handoff", proc.stderr)
        self.assertFalse(self.state.exists())

    def test_creates_the_state_file_when_missing(self):
        self.write_bundle(handoff([job("j1", "Platform Engineer", "Example Labs", 88)]))
        self.assertFalse(self.state.exists())
        self.run_tool()
        self.assertEqual(len(self.read_state()), 1)

    def test_dry_run_reports_without_writing(self):
        self.write_bundle(handoff([job("j1", "Platform Engineer", "Example Labs", 88)]))
        out = json.loads(self.run_tool("--dry-run").stdout)
        self.assertTrue(out["dry_run"])
        self.assertEqual(len(out["imported"]), 1)
        self.assertFalse(self.state.exists())

    def test_missing_posting_date_stays_null(self):
        self.write_bundle(handoff([job("j1", "Platform Engineer", "Example Labs", 88, date=None)]))
        self.run_tool()
        self.assertIsNone(next(iter(self.read_state().values()))["posted_date"])

    def test_unevaluated_postings_are_skipped_not_imported(self):
        raw = job("j1", "Platform Engineer", "Example Labs", 88)
        del raw["evaluation"]
        self.write_bundle(handoff([raw]))
        out = json.loads(self.run_tool().stdout)
        self.assertEqual(out["imported"], [])
        self.assertEqual(out["skipped"][0]["reason"], "no evaluation")


if __name__ == "__main__":
    unittest.main()
