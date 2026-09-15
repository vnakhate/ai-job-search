import { z } from "zod";
import type { TraceEvent } from "@orcareplay/schema";
export const ProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    country: z.string().regex(/^[A-Z]{2}$/),
    role: z.string().trim().min(2).max(150),
    skills: z.string().trim().min(2).max(2000),
    experience: z.string().trim().min(20).max(6000),
    languages: z.string().trim().min(2).max(1000),
    workRights: z.string().trim().min(2).max(1500),
    constraints: z.string().max(1500),
    remote: z.boolean(),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;
export const PlanSchema = z
  .object({ query: z.string().min(2).max(150), reason: z.string().max(1000) })
  .strict();
export const EvaluationSchema = z
  .object({
    score: z.number().int().min(0).max(100),
    eligibility: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
    language: z.enum(["PASS", "FAIL", "FLAG"]),
    reason: z.string().min(1).max(2500),
    evidence: z.array(z.string().min(1).max(700)).min(1).max(8),
    gaps: z.array(z.string().max(500)).max(10),
  })
  .strict();
export const DraftSchema = z
  .object({
    coverLetter: z.string().min(50).max(7000),
    cvBullets: z.array(z.string().min(1).max(800)).min(1).max(8),
    verificationNotes: z.array(z.string().max(800)).min(1).max(10),
  })
  .strict();
export type Evaluation = z.infer<typeof EvaluationSchema>;
export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  date: string | null;
  evaluation?: Evaluation;
  draft?: z.infer<typeof DraftSchema>;
  decision?: "approved" | "rejected";
  applied?: string;
}
export type Status =
  "running" | "paused" | "review" | "completed" | "cancelled" | "failed";
export interface Run {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: Status;
  stage: "plan" | "search" | "evaluate" | "draft" | "done";
  profile: Profile;
  query?: string;
  planReason?: string;
  jobs: Job[];
  cursor: number;
  modelCalls: number;
  attempts: Record<string, number>;
  events: TraceEvent[];
  error?: string;
  demo: boolean;
  contextHash: string;
}
export interface Entitlement {
  active: boolean;
  customerId?: string;
  expiresAt: number;
  status: string;
}
export interface Account {
  profile?: Profile;
  runs: Run[];
  entitlement: Entitlement;
  month: string;
  used: number;
}
export interface Env {
  ACCOUNTS: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI?: Ai;
  APP_ORIGIN: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_IOS_CLIENT_ID?: string;
  OIDC_AUDIENCE: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID: string;
  DEMO_MODE: string;
}
export const MAX_RUNS_PER_MONTH = 60;
export function isDemo(env: Env) {
  return (
    env.DEMO_MODE === "true" &&
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(env.APP_ORIGIN)
  );
}
export function postedLabel(date: string | null, now = Date.now()) {
  const stamp = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(stamp)) return "Posting date unknown";
  const days = Math.floor((now - stamp) / 86400000);
  if (days <= 0) return "Posted today";
  if (days === 1) return "Posted yesterday";
  return `Posted ${days} days ago`;
}
export function blockReason(job: Job): string | null {
  const e = job.evaluation;
  if (!e || canDraft(job)) return null;
  const rights = e.eligibility === "FAIL";
  const language = e.language === "FAIL";
  if (rights && language) return "Blocked: work rights and language";
  if (rights) return "Blocked: work rights";
  if (language) return "Blocked: language";
  return "Verify work rights first";
}
export function canDraft(job: Job) {
  return (
    job.evaluation?.eligibility === "PASS" && job.evaluation.language !== "FAIL"
  );
}
export function publicAccount(account: Account) {
  return {
    ...account,
    runs: account.runs.map(({ profile, ...run }) => ({
      ...run,
      profile: undefined,
      jobs: run.jobs.map(({ description, ...job }) => job),
    })),
  };
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
  } catch {
    return "";
  }
}
