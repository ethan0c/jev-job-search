import { describe, expect, it } from "vitest";
import { LOCATION_MULTIPLIER, REMOTE_MULTIPLIER } from "../src/config.js";
import { locationTier, outsideCountries, preFilter } from "../src/jobs/hardFilters.js";
import { isoDay, parseAppliedCsv, planImport } from "../src/jobs/importApplied.js";
import { locationWeight, type LocationPrefs } from "../src/jobs/location.js";
import { jobId } from "../src/jobs/normalize.js";
import { costOfLiving, floorRefuses, formatPay, meetsFloor, parsePayFloor, payFromText } from "../src/jobs/pay.js";
import { sortByPay, type QueueEntry } from "../src/jobs/queue.js";
import { pickJobs } from "../src/run/pipeline.js";
import { Policy, policyRefuses } from "../src/run/policy.js";

let posting = 1000;
const entry = (id: string, over: { company?: string; title?: string; score?: number; description?: string; locations?: string[]; status?: string } = {}): QueueEntry => {
  // Greenhouse postings are keyed by their number, so each made-up job gets its own.
  const url = `https://job-boards.greenhouse.io/acme${id}/jobs/${posting++}`;
  return {
    job: { id: jobId(url), source: "t", company: over.company ?? `Co ${id}`, title: over.title ?? "SWE Intern", url, ats: "greenhouse", locations: over.locations ?? ["Austin, TX"], postedAt: "2026-10-06", terms: [], sponsorship: "unknown", degrees: [], category: null, ...(over.description ? { description: over.description } : {}) },
    fit: { score: over.score ?? 0.5, decision: "apply", skipReason: null, reasons: [], components: {}, locationTier: "us", answers: {} },
    preFilterReason: null, status: over.status ?? "queued", statusReason: null, attempts: 0, discoveredAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z", appliedAt: null, notes: null,
    waitingFor: null, answers: [], replies: [], response: null,
  } as unknown as QueueEntry;
};

describe("payFromText", () => {
  it.each([
    ["The base pay range for this role is $40 - $48 per hour.", ["New York, NY"], { min: 40, max: 48, currency: "USD", period: "hour" }],
    ["Salary range: $120,000 - $150,000 USD annually", [], { min: 120000, max: 150000, currency: "USD", period: "year" }],
    ["Compensation: CA$125K – CA$130K", [], { min: 125000, max: 130000, currency: "CAD", period: "year" }],
    ["salary $70-85k", ["Austin, TX"], { min: 70000, max: 85000, currency: "USD", period: "year" }],
    ["The hourly rate for this internship is $45.50", ["Toronto, ON"], { min: 45.5, max: 45.5, currency: "CAD", period: "hour" }],
    ["SF: $50-$55/hour. NYC: $48 - $53 per hour.", ["SF"], { min: 48, max: 55, currency: "USD", period: "hour" }],
    ["We raised a $50M Series B. Pay: $35/hr", ["Austin, TX"], { min: 35, max: 35, currency: "USD", period: "hour" }],
    ["Pay range $30 to $40 an hour plus a $2,000 signing bonus", ["Austin, TX"], { min: 30, max: 40, currency: "USD", period: "hour" }],
  ])("%s", (text, locations, pay) => {
    expect(payFromText(text, locations)).toEqual(pay);
  });
  it.each([
    ["$5,000 relocation bonus"],
    ["We offer up to $20,000 annually in tuition"],
    ["Housing stipend of $3,000 per month"],
    ["We serve 2,000 customers across 40 states"],
    ["Backed by $120M from top investors"],
  ])("reads no pay in %s", (text) => {
    expect(payFromText(text, ["Austin, TX"])).toBeNull();
  });
  it("reads a bare dollar sign on a remote posting in the default currency, and not abroad", () => {
    expect(payFromText("Pay: $40 per hour", ["Remote"])?.currency).toBe("USD");
    expect(payFromText("Pay: $40 per hour", [])?.currency).toBe("USD");
    expect(payFromText("Pay: $40 per hour", ["London, UK"])).toBeNull();
  });
  it("prints pay as a person reads it", () => {
    expect(formatPay({ min: 40, max: 48, currency: "USD", period: "hour" })).toBe("$40 to 48 an hour");
    expect(formatPay({ min: 70000, max: 85000, currency: "CAD", period: "year" })).toBe("CAD 70k to 85k a year");
  });
});

describe("pay floor", () => {
  it("reads hourly and yearly floors, with or without a currency", () => {
    expect(parsePayFloor("30/h")).toMatchObject({ hourly: 30, currency: "USD" });
    expect(parsePayFloor("$30/hr")).toMatchObject({ hourly: 30, currency: "USD" });
    expect(parsePayFloor("CAD 35/h")).toMatchObject({ hourly: 35, currency: "CAD" });
    expect(parsePayFloor("62400/y").hourly).toBeCloseTo(30);
    expect(parsePayFloor("62.4k").hourly).toBeCloseTo(30);
    expect(() => parsePayFloor("thirty")).toThrow(/pay floor/);
  });
  it("judges by the top of the range, and does not judge what it cannot read", () => {
    const floor = parsePayFloor("30/h");
    expect(meetsFloor({ min: 20, max: 32, currency: "USD", period: "hour" }, floor)).toBe(true);
    expect(meetsFloor({ min: 18, max: 25, currency: "USD", period: "hour" }, floor)).toBe(false);
    expect(meetsFloor({ min: 70000, max: 80000, currency: "USD", period: "year" }, floor)).toBe(true);
    expect(meetsFloor(null, floor)).toBeNull();
    expect(meetsFloor({ min: 10, max: 12, currency: "CAD", period: "hour" }, floor)).toBeNull();
  });
});

describe("choosing jobs by pay", () => {
  const low = entry("low", { score: 0.9, description: "Pay range: $22 - $25 per hour" });
  const high = entry("high", { score: 0.4, description: "Pay range: $45 - $50 per hour" });
  const silent = entry("silent", { score: 0.8 });
  const cad = entry("cad", { score: 0.7, description: "Pay range: CA$60 - CA$70 per hour", locations: ["Toronto, ON"] });

  it("puts the highest stated pay first, and jobs with none after, in fit order", () => {
    expect(sortByPay([low, silent, high, cad], "USD").map((e) => e.job.company)).toEqual(["Co high", "Co low", "Co silent", "Co cad"]);
  });
  it("leaves out only jobs whose stated pay is under the floor", () => {
    const got = pickJobs([low, high, silent, cad], [], { count: 10, dry: true, minPay: parsePayFloor("30/h") });
    expect(got.picked.map((e) => e.job.company).sort()).toEqual(["Co cad", "Co high", "Co silent"]);
    expect(got.underFloor).toBe(1);
  });
  it("orders by fit unless asked for pay", () => {
    expect(pickJobs([low, high, silent], [], { count: 1, dry: true }).picked[0]?.job.company).toBe("Co low");
    expect(pickJobs([low, high, silent], [], { count: 1, dry: true, sort: "pay" }).picked[0]?.job.company).toBe("Co high");
  });
  it("never lets a floor or an order bring back a job already applied to", () => {
    const sent = entry("sent", { description: "Pay range: $90 - $95 per hour", status: "applied" });
    expect(pickJobs([sent, silent], [], { count: 5, dry: true, sort: "pay" }).picked.map((e) => e.job.company)).toEqual(["Co silent"]);
  });
  it("keeps the daily policy's floor in code", () => {
    const p = Policy.parse({ minPay: "30/h" });
    expect(policyRefuses({ ...low, fit: { ...low.fit!, score: 0.9 } }, p)).toMatch(/under your floor/);
    expect(policyRefuses({ ...silent, fit: { ...silent.fit!, score: 0.9 } }, p)).toBeNull();
    expect(Policy.safeParse({ minPay: "lots" }).success).toBe(false);
    expect(Policy.parse({}).minPay).toBe("");
    // A policy written before the tiers were made neutral still loads.
    expect(Policy.parse({ where: ["vancouver", "us"] }).where).toEqual(["canada", "us"]);
  });
});

describe("locationWeight", () => {
  // A made-up candidate in Pennsylvania who wants an office and takes remote only as a last resort.
  const pa: LocationPrefs = { preferred: ["Pittsburgh, PA", "Philadelphia, PA"], authorized: ["United States"], remote: "last_resort" };
  const w = (locations: string[], prefs = pa) => locationWeight(locations, locationTier(locations), prefs).multiplier;

  it("weighs a listed city first, then the rest of the country, then remote last", () => {
    expect(w(["Pittsburgh, PA"])).toBe(LOCATION_MULTIPLIER.preferred);
    expect(w(["Austin, TX"])).toBe(LOCATION_MULTIPLIER.authorizedCountry);
    expect(w(["Remote"])).toBe(REMOTE_MULTIPLIER.last_resort);
    expect(w(["Remote - US"])).toBe(REMOTE_MULTIPLIER.last_resort);
    expect(w(["Pittsburgh, PA"])).toBeGreaterThan(w(["Austin, TX"]));
    expect(w(["Austin, TX"])).toBeGreaterThan(w(["Remote"]));
  });
  it("weighs a posting with an office and remote by the office", () => {
    expect(w(["Philadelphia, PA", "Remote"])).toBe(LOCATION_MULTIPLIER.preferred);
    expect(w(["Austin, TX", "Remote"])).toBe(LOCATION_MULTIPLIER.authorizedCountry);
  });
  it("puts a country where sponsorship is needed under the candidate's own", () => {
    expect(w(["Toronto, ON"])).toBe(LOCATION_MULTIPLIER.otherCountry);
    expect(w(["London, UK"])).toBe(LOCATION_MULTIPLIER.international);
  });
  it("follows the remote preference, and a country entry covers the whole country", () => {
    const ca: LocationPrefs = { preferred: ["Canada", "Remote"], authorized: ["Canada"], remote: "preferred" };
    expect(w(["Toronto, ON"], ca)).toBe(LOCATION_MULTIPLIER.preferred);
    expect(w(["Remote"], ca)).toBe(REMOTE_MULTIPLIER.preferred);
    expect(w(["Remote - US"], ca)).toBe(LOCATION_MULTIPLIER.otherCountry);
  });
  it("keeps a strong remote job above the queue's threshold at last resort", () => {
    expect(0.7 * REMOTE_MULTIPLIER.last_resort * 0.85).toBeGreaterThan(0.3);
  });
  it("says why when it changed the rank", () => {
    expect(locationWeight(["Remote"], "remote", pa).reason).toMatch(/last/);
    expect(locationWeight(["Pittsburgh, PA"], "us", pa).reason).toMatch(/listed/);
  });
});

describe("import-applied", () => {
  const listed = entry("a", { company: "Acme, Inc.", title: "Software Engineer Intern" });
  const twin1 = entry("b", { company: "Globex", title: "SWE Intern" });
  const twin2 = entry("c", { company: "Globex", title: "SWE Intern" });

  it("reads the columns it needs, under the names people use", () => {
    const rows = parseAppliedCsv("Company,Role / Title,Job Link,Applied On\nAcme,SWE,https://jobs.lever.co/acme/123e4567-e89b-12d3-a456-426614174000,10/14/2026\n,,,\n");
    expect(rows).toEqual([{ company: "Acme", title: "SWE", link: "https://jobs.lever.co/acme/123e4567-e89b-12d3-a456-426614174000", appliedOn: "2026-10-14", line: 2 }]);
    expect(() => parseAppliedCsv("Name,Link\nx,y\n")).toThrow(/Company/);
  });
  it("reads dates in the two common forms", () => {
    expect(isoDay("2026-10-14")).toBe("2026-10-14");
    expect(isoDay("1/4/26")).toBe("2026-01-04");
    expect(isoDay("yesterday")).toBeNull();
  });
  it("marks a job by its link, or by employer and exact title when only one fits", () => {
    const plan = planImport([listed, twin1, twin2], [
      { company: "Acme", title: "x", link: listed.job.url, appliedOn: null, line: 2 },
      { company: "ACME Inc", title: "software engineer intern", link: "", appliedOn: null, line: 3 },
    ]);
    expect(plan.map((s) => s.kind)).toEqual(["mark", "mark"]);
    expect(plan.map((s) => (s.kind === "mark" ? s.id : ""))).toEqual([listed.job.id, listed.job.id]);
  });
  it("adds a linked job the queue has never seen, so a later search keeps it as applied", () => {
    const [step] = planImport([], [{ company: "Initech", title: "Intern", link: "https://boards.greenhouse.io/initech/jobs/42", appliedOn: null, line: 2 }]);
    expect(step?.kind).toBe("add");
  });
  it("gives each made-up job its own id", () => {
    expect(new Set([listed, twin1, twin2].map((e) => e.job.id)).size).toBe(3);
  });
  it("records nothing it would have to guess", () => {
    const plan = planImport([listed, twin1, twin2], [
      { company: "Globex", title: "SWE Intern", link: "", appliedOn: null, line: 2 },
      { company: "Hooli", title: "Intern", link: "", appliedOn: null, line: 3 },
      { company: "Acme", title: "", link: "", appliedOn: null, line: 4 },
      { company: "Acme", title: "", link: "ask Sam", appliedOn: null, line: 5 },
    ]);
    expect(plan.map((s) => s.kind)).toEqual(["unmatched", "unmatched", "unmatched", "unmatched"]);
  });
  it("leaves a job already on record alone", () => {
    const sent = entry("d", { status: "applied" });
    expect(planImport([sent], [{ company: sent.job.company, title: "", link: sent.job.url, appliedOn: null, line: 2 }])[0]?.kind).toBe("known");
  });
});

describe("a floor that knows what living costs", () => {
  const floor = parsePayFloor("40/h");
  const job = (locations: string[], description = "") => ({ locations, description });

  it("raises the floor where living costs more, and leaves remote work at the floor", () => {
    expect(costOfLiving(["New York, NY"]).index).toBeGreaterThan(100);
    expect(costOfLiving(["Remote"]).index).toBe(100);
    expect(costOfLiving(["Harrisburg, PA"]).index).toBeLessThan(100);
    expect(costOfLiving(["Lisbon, Portugal"]).index).toBe(100);
    expect(floorRefuses(job(["Remote"], "Pay: $40 per hour"), floor)).toBeNull();
    expect(floorRefuses(job(["New York, NY"], "Pay: $42 per hour"), floor)).toMatch(/in New York/);
    expect(floorRefuses(job(["New York, NY"], "Pay: $46 per hour"), floor)).toBeNull();
    expect(floorRefuses(job(["Redmond, WA"], "Pay: $44 per hour"), floor)).toMatch(/in Seattle/);
  });
  it("takes the cheapest office when a posting lists several", () => {
    expect(costOfLiving(["New York, NY", "Austin, TX"]).place).toMatch(/^Austin/);
    expect(costOfLiving(["New York, NY; Austin, TX"]).place).toMatch(/^Austin/);
    expect(floorRefuses(job(["New York, NY", "Austin, TX"], "Pay: $40 per hour"), floor)).toBeNull();
  });
  it("asks a remote-only job to prove its pay when remote is a last resort, and no one else", () => {
    expect(floorRefuses(job(["Remote"]), floor)).toBeNull();
    expect(floorRefuses(job(["Remote"]), floor, { remoteNeedsPay: true })).toMatch(/remote/);
    expect(floorRefuses(job(["New York, NY", "Remote"]), floor, { remoteNeedsPay: true })).toBeNull();
    expect(floorRefuses(job(["Austin, TX"]), floor, { remoteNeedsPay: true })).toBeNull();
    expect(floorRefuses(job(["Remote"], "Pay: $41 per hour"), floor, { remoteNeedsPay: true })).toBeNull();
  });
  it("carries the remote rule into the daily policy", () => {
    const remote = entry("r", { locations: ["Remote"], score: 0.9 });
    const p = Policy.parse({ minPay: "40/h" });
    expect(policyRefuses(remote, p)).toBeNull();
    expect(policyRefuses(remote, p, { remoteNeedsPay: true })).toMatch(/remote/);
  });
});

describe("the countries a person works in", () => {
  const us = ["United States"];
  it.each([
    [["New York, NY"], null],
    [["Remote"], null],
    [[], null],
    [["Remote (US or Canada)"], null],
    [["Toronto, ON"], /Canada/],
    [["Remote - Canada"], /Canada/],
    [["London, UK"], /outside/],
  ])("%j", (locations, want) => {
    const got = outsideCountries(locations as string[], us);
    if (want === null) expect(got).toBeNull();
    else expect(got).toMatch(want);
  });
  it("leaves every country open when the profile names none, and filters before rating", () => {
    expect(outsideCountries(["London, UK"], [])).toBeNull();
    const london = { id: "l", source: "t", company: "Acme", title: "Software Engineer Intern", url: "https://job-boards.greenhouse.io/acme/jobs/7", ats: "greenhouse" as const, locations: ["London, UK"], postedAt: null, terms: [], sponsorship: "unknown" as const, degrees: [], category: null };
    expect(preFilter(london, new Date(), () => false, undefined, undefined, undefined, us)).toMatch(/outside/);
  });
});
