import { describe, expect, it } from "vitest";
import { PAY } from "../src/config.js";
import { costOfPlace, loadCostData, parsePlace } from "../src/jobs/costOfLiving.js";
import { splitMetroName } from "../src/tools/costOfLiving.js";

// knowledge/cost-of-living.json is BEA's own table, built by `npm run cost-data`: real data, no one's information.
const data = loadCostData();
const where = (place: string) => costOfPlace(place, data);

describe("the BEA table", () => {
  it("covers every state and DC, and the metros", () => {
    expect(data?.states).toHaveLength(51);
    expect(data?.metros.length).toBeGreaterThan(380);
  });
  it("sends every alias to a metro that exists", () => {
    const codes = new Set(data?.metros.map((m) => m.code));
    for (const a of PAY.costAliases) expect(codes, a.metro).toContain(a.metro);
  });
});

describe("costOfPlace", () => {
  it.each([
    ["McLean, VA", /^Washington-Arlington-Alexandria/],
    ["Tysons Corner, Virginia", /^Washington-Arlington-Alexandria/],
    ["DMV", /^Washington-Arlington-Alexandria/],
    ["Washington, D.C.", /^Washington-Arlington-Alexandria/],
    ["Washington DC", /^Washington-Arlington-Alexandria/],
    ["Arlington, VA", /^Washington-Arlington-Alexandria/],
    ["Arlington, TX", /^Dallas-Fort Worth-Arlington/],
    ["Plano, TX", /^Dallas-Fort Worth-Arlington/],
    ["Cleveland", /^Cleveland, OH/],
    ["Cleveland, OH", /^Cleveland, OH/],
    ["Cleveland, TN", /^Cleveland, TN/],
    ["Portland, ME", /^Portland-South Portland/],
    ["Redmond, WA", /^Seattle/],
    ["Seattle, Washington, United States", /^Seattle/],
    ["New York, NY", /^New York/],
    ["NYC", /^New York/],
    ["Philadelphia, PA", /^Philadelphia/],
    ["Glen Allen, VA", /^Richmond, VA/],
    ["Nashville, TN", /^Nashville/],
    ["Winston-Salem, NC", /^Winston-Salem/],
    ["Austin TX", /^Austin/],
    ["Pittsburgh, PA (Hybrid)", /^Pittsburgh/],
    ["Pittsburgh, Hybrid", /^Pittsburgh/],
    ["McLean, VA - Onsite", /^Washington-Arlington-Alexandria/],
  ])("%s", (place, metro) => {
    const got = where(place);
    expect(got?.how).toBe("metro");
    expect(got?.place).toMatch(metro);
  });
  it("falls back to the state for a town it does not know", () => {
    expect(where("Smalltown, PA")).toMatchObject({ how: "state", place: "Pennsylvania" });
    expect(where("Somewhere, Virginia")).toMatchObject({ how: "state", place: "Virginia" });
  });
  it("guesses nothing: another country, remote, or a city in two states with no state given", () => {
    expect(where("Cambridge, UK")).toBeNull();
    expect(where("Toronto, ON")).toBeNull();
    expect(where("Vienna, Austria")).toBeNull();
    expect(where("Remote - US")).toBeNull();
    expect(where("Springfield")).toBeNull();
  });
  it("ranks the places the way BEA does", () => {
    const at = (p: string) => where(p)?.index ?? 0;
    expect(at("San Francisco, CA")).toBeGreaterThan(at("Philadelphia, PA"));
    expect(at("McLean, VA")).toBeGreaterThan(at("Cleveland, OH"));
    expect(at("New York, NY")).toBeGreaterThan(100);
    expect(at("Cleveland, OH")).toBeLessThan(100);
  });
});

describe("reading places and metro names", () => {
  it("splits a place into its city and state", () => {
    expect(parsePlace("McLean, VA")).toEqual({ city: "mclean", state: "VA", abroad: false });
    expect(parsePlace("Austin TX")).toEqual({ city: "austin", state: "TX", abroad: false });
    expect(parsePlace("Greater Boston Area")).toMatchObject({ city: "boston", state: null });
    expect(parsePlace("London, UK").abroad).toBe(true);
  });
  it("reads BEA's metro names, double dashes and slashes included", () => {
    expect(splitMetroName("Washington-Arlington-Alexandria, DC-VA-MD-WV (Metropolitan Statistical Area)")).toEqual({ cities: ["Washington", "Arlington", "Alexandria"], states: ["DC", "VA", "MD", "WV"] });
    expect(splitMetroName("Nashville-Davidson--Murfreesboro--Franklin, TN (Metropolitan Statistical Area)")?.cities).toEqual(["Nashville-Davidson", "Nashville", "Murfreesboro", "Franklin"]);
    expect(splitMetroName("Winston-Salem, NC (Metropolitan Statistical Area)")?.cities).toContain("Winston-Salem");
    expect(splitMetroName("Louisville/Jefferson County, KY-IN (Metropolitan Statistical Area)")?.cities).toEqual(["Louisville", "Jefferson County"]);
    expect(splitMetroName("United States (Nonmetropolitan Portion) *")).toBeNull();
  });
});
