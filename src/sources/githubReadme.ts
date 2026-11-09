/**
 * Parser for the community internship lists kept as markdown tables:
 *   | Company | Role | Location | Apply | Date Posted |
 * Rows may start with "↳" (same company as the row above), carry 🔒 (closed),
 * 🛂 (no sponsorship) or 🇺🇸 (citizenship required), and link the apply
 * button as <a href=...> or [![Apply](badge)](url).
 */
import { DISCOVER } from "../config.js";
import { getText } from "../util/http.js";
import { decodeEntities } from "../util/text.js";
import { atsFromUrl, canonicalUrl, jobId, parseLooseDate, type Job, type Sponsorship } from "../jobs/normalize.js";

export function parseReadmeTable(markdown: string, source: string, now = new Date()): Job[] {
  const out: Job[] = [];
  let lastCompany = "";
  let headerSeen = false;
  let cols: { company: number; role: number; location: number; apply: number; date: number } | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    const lower = cells.map((c) => c.toLowerCase());
    if (!headerSeen || lower.includes("company")) {
      if (lower.includes("company")) {
        cols = {
          company: lower.indexOf("company"),
          role: lower.findIndex((c) => /role|position|title/.test(c)),
          location: lower.indexOf("location"),
          apply: lower.findIndex((c) => /apply|application|link/.test(c)),
          date: lower.findIndex((c) => /date|posted|age/.test(c)),
        };
        headerSeen = true;
        continue;
      }
      continue;
    }
    if (!cols || cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? "") : "");
    const companyRaw = clean(cell(cols.company));
    const company = companyRaw === "↳" || companyRaw === "" ? lastCompany : companyRaw;
    if (companyRaw && companyRaw !== "↳") lastCompany = companyRaw;
    const roleRaw = cell(cols.role);
    const applyRaw = cell(cols.apply);
    if (/🔒/.test(applyRaw) || /🔒/.test(roleRaw)) continue;
    const url = firstHref(applyRaw) ?? firstHref(roleRaw);
    if (!url || !company) continue;
    let sponsorship: Sponsorship = "unknown";
    if (/🛂/.test(roleRaw)) sponsorship = "none";
    if (/🇺🇸/.test(roleRaw)) sponsorship = "citizenship";
    const degrees = /🎓/.test(roleRaw) ? ["Master's", "PhD"] : [];
    const title = clean(roleRaw).replace(/[🛂🇺🇸🎓🔥]/gu, "").replace(/\s+/g, " ").trim();
    const canonical = canonicalUrl(url);
    out.push({
      id: jobId(canonical),
      source,
      company,
      title,
      url: canonical,
      ats: atsFromUrl(canonical),
      locations: splitLocations(clean(cell(cols.location))),
      postedAt: parseLooseDate(clean(cell(cols.date)), now),
      terms: termsFromTitle(title),
      sponsorship,
      degrees,
      category: null,
    });
  }
  return out;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i] as string;
    if (ch === "<" ) depth++;
    if (ch === ">" && depth > 0) depth--;
    if (ch === "|" && depth === 0 && trimmed[i - 1] !== "\\") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const IMAGE_HOST = /img\.shields\.io|imgur\.com|\.(png|svg|gif|jpe?g)(\?|$)/i;

function firstHref(cell: string): string | null {
  const html = /href="([^"]+)"/.exec(cell);
  if (html) return decodeEntities(html[1] as string);
  // [![Apply](badge-image)](real-url): the outer link follows ")](".
  const badge = /\)\]\((https?:\/\/[^)\s]+)\)/.exec(cell);
  if (badge && !IMAGE_HOST.test(badge[1] as string)) return badge[1] as string;
  const md = [...cell.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1] as string).find((u) => !IMAGE_HOST.test(u));
  if (md) return md;
  const bare = [...cell.matchAll(/(https?:\/\/[^\s|)]+)/g)].map((m) => m[1] as string).find((u) => !IMAGE_HOST.test(u));
  return bare ?? null;
}

function clean(cell: string): string {
  return decodeEntities(cell.replace(/<[^>]+>/g, " ").replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ").replace(/\*\*/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function splitLocations(s: string): string[] {
  if (!s) return [];
  return s
    .replace(/\d+ locations?/i, "")
    .split(/<\/?br\s*\/?>|\n|;|\s\/\s|\|/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function termsFromTitle(title: string): string[] {
  const t = title.toLowerCase();
  const terms: string[] = [];
  const m = /(summer|winter|fall|spring)\s*(20\d\d)/g;
  let r: RegExpExecArray | null;
  while ((r = m.exec(t))) terms.push(`${cap(r[1] as string)} ${r[2]}`);
  if (!terms.length && /\b(co-?op|intern)/.test(t)) terms.push("N/A");
  return terms;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** countries: the profile's `preferences.countries`. The lists of Canadian jobs are read only when Canada is one of them, or none is named. */
export async function fetchReadmeSources(countries: string[] = []): Promise<Job[]> {
  const canada = !countries.length || countries.some((c) => /^(canada|ca|can)$/i.test(c.trim()));
  const pairs: Array<[string, string]> = [
    ...(canada ? ([["canadian-2027", DISCOVER.sources.canadianInternships2027]] as Array<[string, string]>) : []),
    ["vansh-2027", DISCOVER.sources.vanshSummer2027],
    ...(canada ? ([["canada-summer-2027", DISCOVER.sources.canadaSummer2027]] as Array<[string, string]>) : []),
  ];
  const out: Job[] = [];
  for (const [source, url] of pairs) {
    try {
      const md = await getText(url, { cacheMs: 30 * 60_000 });
      out.push(...parseReadmeTable(md, source));
    } catch (err) {
      console.error(`[sources] ${source} failed: ${String(err)}`);
    }
  }
  return out;
}
