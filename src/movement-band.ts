export type MovementBand = "walk" | "dash" | "over";

export function movementBand(cost: number, walkDistance: number, dashDistance: number): MovementBand {
  if (cost > dashDistance + 0.01) return "over";
  if (cost > walkDistance + 0.01) return "dash";
  return "walk";
}
