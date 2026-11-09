/**
 * What living costs where a job's office is, from the Bureau of Economic Analysis's Regional Price
 * Parities (knowledge/cost-of-living.json, built by src/tools/costOfLiving.ts; U.S. = 100).
 *
 * A posting's place is found in this order: a name in `PAY.costAliases` (a suburb, a region such
 * as "DMV", or the usual reading of a city that is in two states), then a metro's principal city
 * in the right state, then the state's own figure. A place none of these knows is not guessed.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PATHS, PAY } from "../config.js";

export const CostData = z.object({
  source: z.string(),
  updated: z.string(),
  year: z.number().int(),
  metros: z.array(z.object({
    code: z.string(),
    name: z.string(),
    cities: z.array(z.string()),
    states: z.array(z.string()),
    allItems: z.number(),
    housing: z.number(),
  })),
  states: z.array(z.object({ code: z.string(), name: z.string(), allItems: z.number(), housing: z.number() })),
});
export type CostData = z.infer<typeof CostData>;
type Metro = CostData["metros"][number];

export type Cost = { index: number; place: string; how: "metro" | "state" };

let cached: CostData | null | undefined;
/** The table, read once. A missing table means no adjustment, never an error that stops a run. */
export function loadCostData(file = PATHS.costOfLiving): CostData | null {
  if (cached !== undefined && file === PATHS.costOfLiving) return cached;
  const data = existsSync(file) ? CostData.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
  if (file === PATHS.costOfLiving) cached = data;
  return data;
}

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));

const NOISE = /\b(greater|metro(politan)?|area|region|hq|headquarters|office|offices|campus|hybrid|on-?site|in-?office)\b/g;
/** A second part that only says how the job is worked ("Hybrid", "On-site") is not a country. */
const NOISE_ONLY = /^(hybrid|on-?site|in-?office|remote|flexible)$/i;
const clean = (s: string) => s.toLowerCase().replace(/\./g, "").replace(/\([^)]*\)/g, " ").replace(NOISE, " ").replace(/\s+/g, " ").trim();

const stateOf = (s: string | undefined): string | null => {
  if (!s) return null;
  // "PA (Hybrid)", "VA - Onsite": only the state counts.
  const t = s.replace(/\([^)]*\)/g, " ").split(/\s+[-\u2013]\s+/)[0]!.replace(/\./g, "").trim();
  if (STATE_CODES.has(t.toUpperCase()) && t.length === 2) return t.toUpperCase();
  return STATE_NAMES[t.toLowerCase()] ?? null;
};

/** "McLean, VA", "Austin TX", "Washington, D.C.", "Seattle, Washington, United States": the city as written and its state. */
export function parsePlace(raw: string): { city: string; state: string | null; abroad: boolean } {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  let city = clean(parts[0] ?? "");
  let state = stateOf(parts[1]);
  // "Cambridge, UK", "Toronto, ON": a second part that is neither a state nor the United States is another country.
  const second = (parts[1] ?? "").replace(/\([^)]*\)/g, " ").replace(/\./g, "").trim();
  const abroad = !!second && !state && !/^(us|usa|united states( of america)?)$/i.test(second) && !NOISE_ONLY.test(second);
  // "Austin TX", "Washington DC": a state code written after the city without a comma.
  const tail = /^(.*\S)\s+([a-z]{2})$/.exec(city);
  if (!state && tail?.[1] && tail[2] && STATE_CODES.has(tail[2].toUpperCase())) {
    city = tail[1];
    state = tail[2].toUpperCase();
  }
  return { city, state, abroad };
}

const ALIASES = PAY.costAliases.flatMap((a) => a.names.map((n) => ({ name: clean(n), metro: a.metro })));

function measure(x: { allItems: number; housing: number }): number {
  return PAY.costMeasure === "housing" ? x.housing : x.allItems;
}

/** Where one place string is and what living costs there, or null when the table cannot say. */
export function costOfPlace(raw: string, data: CostData | null = loadCostData()): Cost | null {
  if (!data || /remote|anywhere/i.test(raw)) return null;
  const { city, state, abroad } = parsePlace(raw);
  if (abroad) return null;
  const fits = (m: Metro) => !state || m.states.includes(state);
  const asMetro = (m: Metro): Cost => ({ index: measure(m), place: m.name, how: "metro" });

  const byCode = new Map(data.metros.map((m) => [m.code, m]));
  for (const a of ALIASES) {
    const m = byCode.get(a.metro);
    if (m && a.name === city && fits(m)) return asMetro(m);
  }
  if (city) {
    const hits = data.metros.filter((m) => fits(m) && m.cities.some((c) => clean(c) === city));
    // With no state given, a city in two metros (Portland, Arlington) is not guessed: an alias says which, or the state falls back.
    if (hits.length === 1 && hits[0]) return asMetro(hits[0]);
  }
  const s = state ? data.states.find((x) => x.code === state) : undefined;
  return s ? { index: measure(s), place: s.name, how: "state" } : null;
}
