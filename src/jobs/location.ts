/**
 * How much a job's place counts for this candidate. The tier (`locationTier`) says where a job is;
 * this says how much the person wants it there, from their own profile: the places they listed,
 * the countries they may work in, and how they feel about remote work.
 */
import { LOCATION_MULTIPLIER, REMOTE_MULTIPLIER } from "../config.js";
import type { Profile } from "../profile/schema.js";
import { countryOfLocations, type LocationTier } from "./hardFilters.js";

type Country = "Canada" | "United States";

export type LocationPrefs = {
  /** The profile's preferredLocations, as written: "Philadelphia, PA", "Canada", "Remote". */
  preferred: string[];
  /** The countries the candidate may work in without sponsorship. */
  authorized: string[];
  remote: keyof typeof REMOTE_MULTIPLIER;
};

/** No preference at all: every known country needs sponsorship, remote is fine. Used when a caller has no profile. */
export const NO_PREFS: LocationPrefs = { preferred: [], authorized: [], remote: "open" };

export function locationPrefs(profile: Pick<Profile, "preferences" | "workAuthorization">): LocationPrefs {
  return {
    preferred: profile.preferences.preferredLocations,
    authorized: profile.workAuthorization.authorizedCountries,
    remote: profile.preferences.remote,
  };
}

const COUNTRY_NAMES: Record<Country, RegExp> = {
  Canada: /^(canada|ca|can)$/i,
  "United States": /^(united states( of america)?|u\.?s\.?a?\.?|america)$/i,
};

const countryOf = (name: string): Country | null =>
  (Object.keys(COUNTRY_NAMES) as Country[]).find((c) => COUNTRY_NAMES[c].test(name.trim())) ?? null;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when a listed place names this posting's office: its city, or its whole country when the entry is a country. */
function inPreferred(onsite: string[], country: Country | null, preferred: string[]): boolean {
  for (const entry of preferred) {
    if (/^\s*remote\s*$/i.test(entry)) continue;
    const asCountry = countryOf(entry);
    if (asCountry) {
      if (asCountry === country) return true;
      continue;
    }
    const city = entry.split(",")[0]?.trim();
    if (!city || city.length < 3) continue;
    const re = new RegExp(`\\b${escape(city)}\\b`, "i");
    if (onsite.some((l) => re.test(l))) return true;
  }
  return false;
}

/** What JEV said about a posting whose locations the code could not read, as a place the rules below understand. */
function fromJevTier(tier: LocationTier): { onsite: string[]; remote: boolean } {
  if (tier === "vancouver") return { onsite: ["Vancouver, BC, Canada"], remote: false };
  if (tier === "canada") return { onsite: ["Canada"], remote: false };
  if (tier === "us") return { onsite: ["United States"], remote: false };
  if (tier === "remote") return { onsite: [], remote: true };
  return { onsite: [], remote: false };
}

export type LocationWeight = { multiplier: number; reason: string | null };

/**
 * The multiplier for a job's place. An office comes first: a posting that names an office the
 * person wants, and remote besides, is weighed by the office. Remote alone is weighed by
 * `preferences.remote`, unless it is restricted to a country where the person would need sponsorship.
 */
export function locationWeight(locations: string[], tier: LocationTier, prefs: LocationPrefs): LocationWeight {
  const readable = locations.some((l) => l.trim());
  const place = readable ? { onsite: locations.filter((l) => !/remote/i.test(l)), remote: locations.some((l) => /remote/i.test(l)) } : fromJevTier(tier);
  const authorized = new Set(prefs.authorized.map(countryOf).filter((c): c is Country => !!c));

  const onsiteCountry = place.onsite.length ? countryOfLocations(place.onsite) : null;
  if (place.onsite.length && inPreferred(place.onsite, onsiteCountry, prefs.preferred)) {
    return { multiplier: LOCATION_MULTIPLIER.preferred, reason: "in a place you listed" };
  }
  if (onsiteCountry && authorized.has(onsiteCountry)) return { multiplier: LOCATION_MULTIPLIER.authorizedCountry, reason: null };

  if (place.remote) {
    const remoteCountry = countryOfLocations(locations.filter((l) => /remote/i.test(l)));
    if (remoteCountry && !authorized.has(remoteCountry)) return { multiplier: LOCATION_MULTIPLIER.otherCountry, reason: `remote in ${remoteCountry} only` };
    const why = { preferred: "remote, which you prefer", open: null, last_resort: "remote, ranked last as you asked", no: "remote, which you said no to" }[prefs.remote];
    return { multiplier: REMOTE_MULTIPLIER[prefs.remote], reason: why };
  }

  if (onsiteCountry) return { multiplier: LOCATION_MULTIPLIER.otherCountry, reason: null };
  if (tier === "international") return { multiplier: LOCATION_MULTIPLIER.international, reason: null };
  if (place.onsite.length && readable) return { multiplier: LOCATION_MULTIPLIER.international, reason: null };
  return { multiplier: LOCATION_MULTIPLIER.unclear, reason: null };
}
