import { DEBUG_SETTING, MODULE_ID } from "./constants";

interface Position {
  x: number;
  y: number;
}

export class MovementTracker {
  readonly #moved = new Map<string, number>();
  readonly #lastPositions = new Map<string, Position>();
  readonly #onRefresh: (tokenId?: string) => void;

  constructor(onRefresh: (tokenId?: string) => void) {
    this.#onRefresh = onRefresh;
  }

  initialize(): void {
    Hooks.on("updateCombat", (_combat, changes) => {
      if (!("round" in changes) && !("turn" in changes)) return;
      this.reset();
      this.#debug("Combat turn changed; movement totals reset.");
      this.#onRefresh();
    });

    Hooks.on("deleteCombat", () => {
      this.reset();
      this.#onRefresh();
    });

    Hooks.on("preUpdateToken", (tokenDocument, changes) => {
      if (!game.combat?.started || !tokenDocument.inCombat) return;
      if (changes.x === undefined && changes.y === undefined) return;
      if (!tokenDocument.id) return;
      this.#lastPositions.set(tokenDocument.id, { x: tokenDocument.x, y: tokenDocument.y });
    });

    Hooks.on("updateToken", (tokenDocument, changes) => {
      if (!tokenDocument.id) return;
      const start = this.#lastPositions.get(tokenDocument.id);
      this.#lastPositions.delete(tokenDocument.id);
      if (!start || (changes.x === undefined && changes.y === undefined)) return;

      const distance = this.#measureDistance(start, { x: tokenDocument.x, y: tokenDocument.y });
      if (distance <= 0) return;
      const total = (this.#moved.get(tokenDocument.id) ?? 0) + distance;
      this.#moved.set(tokenDocument.id, total);
      this.#debug(`Token moved ${distance}; total movement is ${total}.`);
      this.#onRefresh(tokenDocument.id);
    });
  }

  getMovedDistance(tokenId: string): number {
    return this.#moved.get(tokenId) ?? 0;
  }

  reset(): void {
    this.#moved.clear();
    this.#lastPositions.clear();
  }

  #measureDistance(start: Position, end: Position): number {
    if (!canvas.grid) return 0;
    try {
      const distance = canvas.grid.measurePath([start, end]).distance;
      return Number.isFinite(distance) ? distance : 0;
    } catch {
      return 0;
    }
  }

  #debug(message: string): void {
    if (game.settings.get(MODULE_ID, DEBUG_SETTING) === true) {
      console.debug(`[Easy Grid Movement] ${message}`);
    }
  }
}
