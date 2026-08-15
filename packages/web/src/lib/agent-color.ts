/**
 * Deterministic color per agent, derived from its id so the same colleague
 * always reads as the same color across sessions/meetings/feeds without
 * needing a stored preference. A small fixed palette (not a hash->hue wheel)
 * keeps every color legible against the monochrome design tokens in both themes.
 */
const PALETTE = [
  "#e05252", // red
  "#e0964f", // orange
  "#d0b93e", // yellow
  "#6fbf5c", // green
  "#4fb3a9", // teal
  "#4f92d1", // blue
  "#8a7fe0", // violet
  "#d16fb8", // pink
];

export function agentColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}
