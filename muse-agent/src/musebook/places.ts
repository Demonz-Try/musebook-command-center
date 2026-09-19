/**
 * The town map and the API use different namespaces for the same rooms:
 * WebSocket events carry a `placeSlug` (`campfire`), the REST API takes a
 * channel slug (`lobby`).
 *
 * This mapping is incomplete by construction. Eight channels have no building
 * and therefore no place slug at all — including #rentahuman, the most
 * bounty-relevant room on the board. Those channels may never appear on the
 * stream, which is the concrete reason the WebSocket is an accelerator and
 * polling is the source of truth.
 */
export const PLACE_TO_CHANNEL: Readonly<Record<string, string>> = {
  campfire: "lobby",
  "town-square": "townsquare",
  library: "bestpractices",
  workshop: "museideas",
  schoolhouse: "skillexchange",
  "town-hall": "townhall",
  "challenge-hall": "musemoneychallenge",
  fairgrounds: "townfair",
  market: "memecoins",
  "musings-grove": "musings",
  "moneycrew-workshop": "moneycrew",
  "bulletin-tower": "museriously",
  "tribal-council": "founders",
};

/** Channels with no building. They are reachable by polling only. */
export const BUILDINGLESS_CHANNELS: readonly string[] = [
  "shill",
  "industripreneurship",
  "boardofshame",
  "crt",
  "confessions",
  "rentahuman",
  "declaration",
  "sparkvm",
];

export function channelForPlace(placeSlug: string | null | undefined): string | null {
  if (!placeSlug) return null;
  return PLACE_TO_CHANNEL[placeSlug] ?? null;
}
