/**
 * Pay as a posting states it. Most postings say nothing; where a pay-transparency law makes them,
 * the range is in the description ("The base pay range for this role is $40 - $48 per hour").
 * This reads that range and nothing else: no guess from the title, the employer or the city. A
 * posting with no stated pay has `null`, and every use of pay treats that as unknown, never as low.
 */
import { PAY } from "../config.js";
import { countryOfLocations } from "./hardFilters.js";

export type PayPeriod = "hour" | "week" | "month" | "year";
export type Pay = { min: number; max: number; currency: string; period: PayPeriod };
export type PayFloor = { hourly: number; currency: string; text: string };

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*([kK])?`;
const CUR = String.raw`(USD|CAD|US\$|CA\$|C\$|\$)`;
const AMOUNT = new RegExp(String.raw`(USD|CAD)?\s*${CUR}\s?${NUM}(?:\s*(?:-|\u2013|\u2014|to)\s*(?:USD|CAD)?\s*(?:US\$|CA\$|C\$|\$)?\s?${NUM})?`, "g");
const PAY_WORDS = /\b(pay|salary|salaries|compensation|wage|wages|hourly|rate|base|range|ote|earn)\b/i;
/** Money near these words is a benefit or a company figure, not pay. */
const NOT_PAY = /\b(bonus|relocation|tuition|stipend|budget|401|equity|reimburse\w*|allowance|credit|funding|raised|revenue|valuation|grant|award|prize|donat\w*)\b/i;
const PERIODS: [PayPeriod, RegExp][] = [
  ["hour", /^\s*(?:[A-Z]{3}\s*)?(?:\/\s*(?:hr|hour|h)\b|per\s+hour|an\s+hour|hourly|\/hourly)/i],
  ["week", /^\s*(?:[A-Z]{3}\s*)?(?:\/\s*(?:wk|week)\b|per\s+week|a\s+week|weekly)/i],
  ["month", /^\s*(?:[A-Z]{3}\s*)?(?:\/\s*(?:mo|month)\b|per\s+month|a\s+month|monthly)/i],
  ["year", /^\s*(?:[A-Z]{3}\s*)?(?:\/\s*(?:yr|year|annum)\b|per\s+(?:year|annum)|a\s+year|annually|annual)/i],
];

const amount = (whole: string | undefined, cents: string | undefined, k: string | undefined): number => {
  const n = Number(`${(whole ?? "").replace(/,/g, "")}${cents ? `.${cents}` : ""}`);
  return k ? n * 1000 : n;
};

function currencyOf(code: string | undefined, sign: string, after: string, locations: string[]): string | null {
  if (code) return code.toUpperCase();
  if (sign === "US$") return "USD";
  if (sign === "CA$" || sign === "C$") return "CAD";
  if (sign === "USD" || sign === "CAD") return sign;
  const trailing = /^\s*(USD|CAD)\b/i.exec(after)?.[1];
  if (trailing) return trailing.toUpperCase();
  // A bare "$" is the currency of the country the posting is in. A posting that names no place but
  // remote is read in the default currency; one in another country (London, Sydney) is not read.
  const country = countryOfLocations(locations.filter((l) => !/remote/i.test(l))) ?? countryOfLocations(locations);
  if (country) return country === "Canada" ? "CAD" : "USD";
  return locations.every((l) => /remote/i.test(l) || !l.trim()) ? PAY.defaultCurrency : null;
}

const plausible = (p: PayPeriod, n: number) => n >= PAY.plausible[p][0] && n <= PAY.plausible[p][1];

/** The pay range a text states, or null. Several ranges in one currency and period (one per city) are read as one wide range. */
export function payFromText(text: string | undefined, locations: string[] = []): Pay | null {
  if (!text) return null;
  const found: Pay[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const [whole, code, sign, w1, c1, k1, w2, c2, k2] = m;
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - PAY.contextChars), at);
    const after = text.slice(at + whole.length, at + whole.length + 40);
    const period = PERIODS.find(([, re]) => re.test(after))?.[0] ?? null;
    if (!period && !PAY_WORDS.test(before)) continue;
    // The words next to an amount, up to the next amount or sentence, say what it is ("$20,000 in tuition").
    const named = after.split(/[$.;]/)[0] ?? "";
    const lead = text.slice(Math.max(0, at - 60), at).split(/[$.;]/).at(-1) ?? "";
    if (NOT_PAY.test(lead) || NOT_PAY.test(named)) continue;
    // "1.5M", "$2B": a funding round, not pay.
    if (/^\s*(?:m|mm|b|bn|million|billion)\b/i.test(after)) continue;
    let lo = amount(w1, c1, k1);
    const hi = w2 ? amount(w2, c2, k2) : lo;
    // "$70-85k": the k is written once, on the second number.
    if (w2 && k2 && !k1 && lo < 1000) lo *= 1000;
    const p: PayPeriod | null = period ?? (hi < PAY.plausible.hour[1] ? "hour" : hi >= PAY.plausible.year[0] ? "year" : null);
    if (!p || !plausible(p, lo) || !plausible(p, hi) || hi < lo) continue;
    const currency = currencyOf(code, sign ?? "$", after, locations);
    if (!currency) continue;
    found.push({ min: lo, max: hi, currency, period: p });
  }
  const first = found[0];
  if (!first) return null;
  const same = found.filter((f) => f.currency === first.currency && f.period === first.period);
  return { ...first, min: Math.min(...same.map((f) => f.min)), max: Math.max(...same.map((f) => f.max)) };
}

export function payOf(job: { description?: string | undefined; locations: string[] }): Pay | null {
  return payFromText(job.description, job.locations);
}

/** An amount in a period as an hourly rate, so an internship's hourly pay and a salary can be compared. */
export function hourly(n: number, period: PayPeriod): number {
  if (period === "hour") return n;
  if (period === "week") return n / (PAY.hoursPerYear / 52);
  if (period === "month") return (n * 12) / PAY.hoursPerYear;
  return n / PAY.hoursPerYear;
}

/** "30/h", "$30/hr", "CAD 35/h", "60000/y", "60k": the lowest pay a run will take, as an hourly rate. A bare number under 1000 is hourly, anything else yearly. */
export function parsePayFloor(text: string): PayFloor {
  const m = /^\s*(USD|CAD)?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:\/\s*(h|hr|hour|y|yr|year))?\s*(USD|CAD)?\s*$/i.exec(text);
  if (!m) throw new Error(`"${text}" is not a pay floor. Write it like 30/h, 60000/y, 60k or CAD 35/h`);
  const n = Number((m[2] ?? "").replace(/,/g, "")) * (m[3] ? 1000 : 1);
  const unit = (m[4] ?? "").toLowerCase();
  const period: PayPeriod = unit.startsWith("h") ? "hour" : unit.startsWith("y") ? "year" : n < 1000 ? "hour" : "year";
  const currency = (m[1] ?? m[5] ?? PAY.defaultCurrency).toUpperCase();
  return { hourly: hourly(n, period), currency, text: text.trim() };
}

/**
 * Whether a job's stated pay reaches the floor: the top of its range counts, since the floor is
 * there to leave out clearly underpaid roles. Null when the posting states no pay, or states it in
 * another currency: the tool cannot tell, so the job is kept.
 */
export function meetsFloor(pay: Pay | null, floor: PayFloor): boolean | null {
  if (!pay || pay.currency !== floor.currency) return null;
  return hourly(pay.max, pay.period) >= floor.hourly - 1e-9;
}

/** "$40 to $48 an hour", "CAD 70k to 85k a year": pay as a person reads it. */
export function formatPay(p: Pay | null): string {
  if (!p) return "";
  const n = (x: number) => (p.period === "year" && x >= 1000 ? `${Math.round(x / 1000)}k` : String(Math.round(x * 100) / 100));
  const sign = p.currency === "USD" ? "$" : `${p.currency} `;
  const range = p.min === p.max ? `${sign}${n(p.min)}` : `${sign}${n(p.min)} to ${n(p.max)}`;
  return `${range} a${p.period === "hour" ? "n" : ""} ${p.period}`;
}
