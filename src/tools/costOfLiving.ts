/**
 * Builds knowledge/cost-of-living.json from the Bureau of Economic Analysis's Regional Price
 * Parities: MARPP (every metropolitan area) and SARPP (every state and DC). Nothing in the output
 * is typed by hand; the suburbs a posting names (McLean, Plano, Redmond) are mapped to these metros
 * in `PAY.costAliases` in src/config.ts.
 *
 *   curl -O https://apps.bea.gov/regional/zip/MARPP.zip && unzip MARPP.zip -d marpp
 *   curl -O https://apps.bea.gov/regional/zip/SARPP.zip && unzip SARPP.zip -d sarpp
 *   npm run cost-data -- marpp/MARPP_MSA_2008_2024.csv sarpp/SARPP_STATE_2008_2024.csv
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PATHS } from "../config.js";
import { CostData } from "../jobs/costOfLiving.js";
import { parseCsv } from "../log/csv.js";
import { writeAtomic } from "../util/store.js";

export const STATE_CODES: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE",
  "District of Columbia": "DC", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR",
  Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT",
  Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

type Table = { year: number; updated: string; rows: Map<string, { name: string; allItems?: number; housing?: number }> };

/** One BEA table: for each area, the all-items and housing parities in the latest year it has. */
function readTable(text: string): Table {
  const cells = parseCsv(text).map((r) => r.map((c) => c.trim()));
  const header = cells[0] ?? [];
  const yearCol = header.reduce((best, h, i) => (/^\d{4}$/.test(h) && (best < 0 || Number(h) > Number(header[best])) ? i : best), -1);
  if (yearCol < 0) throw new Error("No year columns: is this a BEA RPP table?");
  const updated = cells.flat().find((c) => /^Last updated:/i.test(c)) ?? "";
  const rows = new Map<string, { name: string; allItems?: number; housing?: number }>();
  for (const r of cells.slice(1)) {
    const [fips, name, , , line] = r;
    const value = Number(r[yearCol]);
    if (!fips || !/^\d{5}$/.test(fips) || !name || !Number.isFinite(value)) continue;
    const row = rows.get(fips) ?? { name };
    if (line === "1") row.allItems = Math.round(value * 10) / 10;
    if (line === "3") row.housing = Math.round(value * 10) / 10;
    rows.set(fips, row);
  }
  return { year: Number(header[yearCol]), updated, rows };
}

/** "Nashville-Davidson--Murfreesboro--Franklin, TN" → the principal cities and the states. */
export function splitMetroName(name: string): { cities: string[]; states: string[] } | null {
  const m = /^(.*),\s*([A-Z]{2}(?:-[A-Z]{2})*)\s*\(Metropolitan Statistical Area\)/.exec(name);
  if (!m?.[1] || !m[2]) return null;
  const names = m[1];
  // A double dash parts the cities when one of them has a hyphen of its own ("Nashville-Davidson").
  // "Nashville-Davidson" is also written "Nashville".
  const parts = (names.includes("--") ? names.split("--").flatMap((p) => (p.includes("-") ? [p, p.split("-")[0] ?? ""] : [p])) : names.split("-")).flatMap((p) => p.split("/"));
  // "Winston-Salem" has a single dash and is one city: keep the whole as well as the parts.
  const whole = !names.includes("--") && (names.match(/-/g) ?? []).length === 1 ? [names] : [];
  const cities = [...new Set([...whole, ...parts].map((c) => c.trim()).filter(Boolean))];
  return { cities, states: m[2].split("-") };
}

export function buildCostData(marpp: string, sarpp: string): CostData {
  const ma = readTable(marpp);
  const sa = readTable(sarpp);
  const metros = [...ma.rows.entries()].flatMap(([code, r]) => {
    const split = splitMetroName(r.name);
    if (!split || r.allItems === undefined || r.housing === undefined) return [];
    return [{ code, name: r.name.replace(/\s*\(Metropolitan Statistical Area\)/, ""), ...split, allItems: r.allItems, housing: r.housing }];
  });
  const states = [...sa.rows.values()].flatMap((r) => {
    const code = STATE_CODES[r.name];
    return code && r.allItems !== undefined && r.housing !== undefined ? [{ code, name: r.name, allItems: r.allItems, housing: r.housing }] : [];
  });
  if (metros.length < 300 || states.length !== 51) throw new Error(`Expected every metro and 51 states, got ${metros.length} metros and ${states.length} states`);
  return CostData.parse({
    source: "U.S. Bureau of Economic Analysis, Regional Price Parities by MSA (MARPP) and by state (SARPP). U.S. = 100.",
    updated: ma.updated,
    year: ma.year,
    metros,
    states,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [marpp, sarpp] = process.argv.slice(2);
  if (!marpp || !sarpp) {
    console.error("usage: npm run cost-data -- <MARPP csv> <SARPP csv>");
    process.exit(1);
  }
  const data = buildCostData(readFileSync(marpp, "utf8"), readFileSync(sarpp, "utf8"));
  writeAtomic(PATHS.costOfLiving, `${JSON.stringify(data, null, 1)}\n`);
  console.log(`${data.metros.length} metros and ${data.states.length} states for ${data.year} written to ${PATHS.costOfLiving}`);
}
