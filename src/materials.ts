// Per-material plunge/peck profiles. Feeds only ever get SLOWER (safe
// direction); a profile can never speed up a move the CAM programmed.

export interface MaterialProfile {
  name: string;
  /** Max straight-plunge feed in mm/min. */
  plungeFeed: number;
  /** Max peck (G83 Q) depth in mm. */
  peckDepth: number;
}

const PROFILES: Record<string, MaterialProfile> = {
  walnut: { name: "walnut", plungeFeed: 350, peckDepth: 2.0 },
  locust: { name: "locust", plungeFeed: 250, peckDepth: 1.2 },
  generic: { name: "generic", plungeFeed: 250, peckDepth: 1.2 },
};

/** Unknown names fall back to the conservative generic profile. */
export function getProfile(name: string): MaterialProfile {
  return PROFILES[name.toLowerCase()] ?? PROFILES.generic;
}

export function profileNames(): string[] {
  return Object.keys(PROFILES);
}
