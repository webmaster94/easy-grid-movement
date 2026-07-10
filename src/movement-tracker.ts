import { DEBUG_SETTING, MODULE_ID } from "./constants";

interface Position {
  x: number;
  y: number;
  elevation: number;
}

export class MovementTracker {
  readonly #moved = new Map<string, number>();
  readonly #lastPositions = new Map<string, Position>();
  readonly #pendingMoves = new Map<string, number>();
  readonly #onRefresh: (tokenId?: string) => void;
  readonly #shouldTrack: (tokenId: string) => boolean;

  constructor(onRefresh: (tokenId?: string) => void, shouldTrack: (tokenId: string) => boolean) {
    this.#onRefresh = onRefresh;
    this.#shouldTrack = shouldTrack;
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
      if (!tokenDocument.id || !this.#shouldTrack(tokenDocument.id)) return;
      if (changes.x === undefined && changes.y === undefined && changes.elevation === undefined) return;
      this.#lastPositions.set(tokenDocument.id, {
        x: tokenDocument._source.x,
        y: tokenDocument._source.y,
        elevation: tokenDocument._source.elevation,
      });
    });

    Hooks.on("updateToken", (tokenDocument, changes) => {
      if (!tokenDocument.id || !this.#shouldTrack(tokenDocument.id)) return;
      const pendingDistance = this.#pendingMoves.get(tokenDocument.id);
      if (pendingDistance !== undefined && this.#positionChanged(changes)) {
        this.#pendingMoves.delete(tokenDocument.id);
        this.#lastPositions.delete(tokenDocument.id);
        const nativeDistance = this.#measureNativeHistory(tokenDocument);
        if (nativeDistance === null) this.#addDistance(tokenDocument.id, pendingDistance);
        else {
          this.#moved.set(tokenDocument.id, nativeDistance);
          this.#debug(`Foundry movement history reports ${nativeDistance} movement spent.`);
          this.#onRefresh(tokenDocument.id);
        }
        return;
      }

      const nativeDistance = this.#measureNativeHistory(tokenDocument);
      if (nativeDistance !== null && "_movementHistory" in changes) {
        this.#pendingMoves.delete(tokenDocument.id);
        this.#moved.set(tokenDocument.id, nativeDistance);
        this.#lastPositions.delete(tokenDocument.id);
        this.#debug(`Foundry movement history reports ${nativeDistance} movement spent.`);
        this.#onRefresh(tokenDocument.id);
        return;
      }

      const start = this.#lastPositions.get(tokenDocument.id);
      this.#lastPositions.delete(tokenDocument.id);
      if (!start || !this.#positionChanged(changes)) return;
      const distance = this.#measureDistance(start, {
        x: tokenDocument._source.x,
        y: tokenDocument._source.y,
        elevation: tokenDocument._source.elevation,
      });
      if (distance > 0) this.#addDistance(tokenDocument.id, distance);
    });
  }

  getMovedDistance(token: Token): number {
    const nativeDistance = this.#measureNativeHistory(token.document);
    return Math.max(this.#moved.get(token.id) ?? 0, nativeDistance ?? 0);
  }

  beginPlannedMove(tokenId: string, distance: number): void {
    this.#pendingMoves.set(tokenId, distance);
  }

  cancelPlannedMove(tokenId: string): void {
    this.#pendingMoves.delete(tokenId);
  }

  finishPlannedMove(tokenId: string): void {
    const distance = this.#pendingMoves.get(tokenId);
    if (distance === undefined) return;
    this.#pendingMoves.delete(tokenId);
    this.#addDistance(tokenId, distance);
  }

  reset(tokenId?: string): void {
    if (tokenId) {
      this.#moved.delete(tokenId);
      this.#lastPositions.delete(tokenId);
      this.#pendingMoves.delete(tokenId);
      return;
    }
    this.#moved.clear();
    this.#lastPositions.clear();
    this.#pendingMoves.clear();
  }

  #positionChanged(changes: TokenUpdate): boolean {
    return changes.x !== undefined || changes.y !== undefined || changes.elevation !== undefined;
  }

  #addDistance(tokenId: string, distance: number): void {
    const total = Math.round(((this.#moved.get(tokenId) ?? 0) + distance) * 100) / 100;
    this.#moved.set(tokenId, total);
    this.#debug(`Token moved ${distance}; total movement is ${total}.`);
    this.#onRefresh(tokenId);
  }

  #measureNativeHistory(tokenDocument: TokenDocument): number | null {
    const history = tokenDocument._movementHistory;
    const token = tokenDocument.id ? canvas.tokens.get(tokenDocument.id) : undefined;
    if (!token || !history || history.length < 2) return null;
    try {
      const measurement = token.measureMovementPath(history, { preview: false });
      const cost = measurement.cost ?? measurement.distance;
      return Number.isFinite(cost) ? cost : null;
    } catch {
      return null;
    }
  }

  #measureDistance(start: Position, end: Position): number {
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
