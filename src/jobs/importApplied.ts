/**
 * Applications the person sent without the tool: a CSV of what they applied to, so a run never
 * applies to those jobs again. A row with a link is the posting itself. A row without one is
 * matched by employer and exact title against the queue, and only when exactly one job fits; a
 * guess could hide a job the person never applied to, so an unclear row is reported, not recorded.
 */
import { parseCsv } from "../log/csv.js";
import { employerKey } from "../run/pipeline.js";
import { MAYBE_SENT, type QueueEntry } from "./queue.js";
import { atsFromUrl, canonicalUrl, jobId, type Job } from "./normalize.js";

export type AppliedRow = { company: string; title: string; link: string; appliedOn: string | null; line: number };

export type ImportStep =
  | { kind: "mark"; row: AppliedRow; id: string }
  | { kind: "add"; row: AppliedRow; job: Job }
  | { kind: "known"; row: AppliedRow; id: string }
  | { kind: "unmatched"; row: AppliedRow; why: string };

/** The rows of a CSV with at least a Company column; Role or Title, Job Link or URL, and Applied On or Date are read when present. */
export function parseAppliedCsv(text: string): AppliedRow[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const col = (re: RegExp) => header.findIndex((h) => re.test(h.trim()));
  const iCompany = col(/^company/i);
  const iTitle = col(/role|title|position/i);
  const iLink = col(/link|url/i);
  const iDate = col(/applied on|^date|applied date|date applied/i);
  if (iCompany < 0) throw new Error("The CSV needs a Company column, and a Job Link or a Role column to say which job");
  const out: AppliedRow[] = [];
  rows.forEach((r, i) => {
    const company = (r[iCompany] ?? "").trim();
    if (!company) return;
    out.push({
      company,
      title: iTitle >= 0 ? (r[iTitle] ?? "").trim() : "",
      link: iLink >= 0 ? (r[iLink] ?? "").trim() : "",
      appliedOn: iDate >= 0 ? isoDay(r[iDate] ?? "") : null,
      line: i + 2,
    });
  });
  return out;
}

/** "2026-10-14", "10/14/2026", "10/14/26": the day as YYYY-MM-DD, or null when it is not a date. */
export function isoDay(text: string): string | null {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : us ? [us[3]?.length === 2 ? `20${us[3]}` : us[3], us[1], us[2]] : [];
  if (!y || !m || !d) return null;
  const day = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ? null : day;
}

const sameTitle = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** What importing the rows would do to the queue, row by row. Nothing is written here. */
export function planImport(entries: QueueEntry[], rows: AppliedRow[]): ImportStep[] {
  const byId = new Map(entries.map((e) => [e.job.id, e]));
  return rows.map((row): ImportStep => {
    if (/^https?:\/\//i.test(row.link)) {
      const url = canonicalUrl(row.link);
      const id = jobId(url);
      const e = byId.get(id);
      if (e) return MAYBE_SENT.includes(e.status) ? { kind: "known", row, id } : { kind: "mark", row, id };
      return {
        kind: "add",
        row,
        job: { id, source: "applied-import", company: row.company, title: row.title, url, ats: atsFromUrl(url), locations: [], postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null },
      };
    }
    if (row.link) return { kind: "unmatched", row, why: `"${row.link}" is not a link` };
    if (!row.title) return { kind: "unmatched", row, why: "no link and no role, so the job cannot be told apart" };
    const key = employerKey(row.company);
    const hits = entries.filter((e) => employerKey(e.job.company) === key && sameTitle(e.job.title, row.title));
    const open = hits.filter((e) => !MAYBE_SENT.includes(e.status));
    if (hits.length && !open.length) return { kind: "known", row, id: hits[0]!.job.id };
    if (open.length === 1) return { kind: "mark", row, id: open[0]!.job.id };
    if (open.length > 1) return { kind: "unmatched", row, why: `${open.length} jobs in the queue have this employer and title (${open.map((e) => e.job.id).join(", ")}); add the link` };
    return { kind: "unmatched", row, why: "not in the queue; add the link so a later search knows it" };
  });
}
