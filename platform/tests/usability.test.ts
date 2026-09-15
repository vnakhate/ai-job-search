import { describe, it, expect } from "vitest";
import * as contracts from "../worker/contracts";
const { postedLabel, blockReason } = contracts as any;
const DAY = 86400000;
const now = Date.parse("2026-09-14T12:00:00Z");
const job = (eligibility?: string, language?: string) => ({
  id: "x",
  title: "t",
  company: "c",
  location: "l",
  url: "",
  description: "",
  date: null,
  ...(eligibility
    ? {
        evaluation: {
          score: 0,
          eligibility,
          language,
          reason: "",
          evidence: ["e"],
          gaps: [],
        },
      }
    : {}),
});
describe("postedLabel", () => {
  it("says the date is unknown when the source gave none", () => {
    expect(postedLabel(null, now)).toBe("Posting date unknown");
  });
  it("reads today, yesterday, then days ago", () => {
    expect(postedLabel(new Date(now - 3600000).toISOString(), now)).toBe(
      "Posted today",
    );
    expect(postedLabel(new Date(now - DAY).toISOString(), now)).toBe(
      "Posted yesterday",
    );
    expect(postedLabel(new Date(now - 5 * DAY).toISOString(), now)).toBe(
      "Posted 5 days ago",
    );
  });
  it("treats an unparseable date as unknown rather than guessing", () => {
    expect(postedLabel("ASAP", now)).toBe("Posting date unknown");
  });
});
describe("blockReason", () => {
  it("is null for a draftable role, including a flagged language", () => {
    expect(blockReason(job("PASS", "PASS"))).toBeNull();
    expect(blockReason(job("PASS", "FLAG"))).toBeNull();
  });
  it("names both gates when both fail", () => {
    expect(blockReason(job("FAIL", "FAIL"))).toBe(
      "Blocked: work rights and language",
    );
  });
  it("names the single failing gate", () => {
    expect(blockReason(job("FAIL", "PASS"))).toBe("Blocked: work rights");
    expect(blockReason(job("PASS", "FAIL"))).toBe("Blocked: language");
  });
  it("asks for verification when work rights are unverified", () => {
    expect(blockReason(job("UNVERIFIED", "PASS"))).toBe(
      "Verify work rights first",
    );
  });
  it("is null before a posting has been evaluated", () => {
    expect(blockReason(job())).toBeNull();
  });
});
