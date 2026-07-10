import { DEBUG_SETTING, MODULE_ID } from "./constants";
import {
  cellsWithin,
  findReachability,
  offsetKey,
  parseOffsetKey,
  type GridOffset,
  type ReachabilityAdapter,
  type ReachabilityResult,
} from "./grid";
import { MovementTracker } from "./movement-tracker";
import { MovementRenderer } from "./renderer";

export interface MovementPlan {
  tokenId: string;
  start: GridOffset;
  walk: Set<string>;
  dash: Set<string>;
  reachability: ReachabilityResult;
  remainingWalk: number;
  remainingDash: number;
}

export class EasyGridMovement {
  readonly #renderer = new MovementRenderer();
  readonly #tracker = new MovementTracker(
    (tokenId) => this.refresh(tokenId),
    (tokenId) => this.#active && tokenId === this.#tokenId,
  );
  #active = false;
  #initialized = false;
  #moving = false;
  #plan: MovementPlan | null = null;
  #tokenId: string | null = null;

  get active(): boolean {
    return this.#active;
  }

  get moving(): boolean {
    return this.#moving;
  }

  initialize(): void {
    if (this.#initialized) return;
    this.#initialized = true;

    game.settings.register(MODULE_ID, DEBUG_SETTING, {
      name: game.i18n.localize("EGM.Settings.DebugName"),
      hint: game.i18n.localize("EGM.Settings.DebugHint"),
      scope: "client",
      config: true,
      type: Boolean,
      default: false,
    });

    game.keybindings.register(MODULE_ID, "toggleHighlight", {
      name: game.i18n.localize("EGM.Keybind.ToggleName"),
      hint: game.i18n.localize("EGM.Keybind.ToggleHint"),
      editable: [{ key: "KeyM" }],
      onDown: () => {
        this.toggle();
        return true;
      },
    });

    Hooks.on("controlToken", (token, controlled) => {
      if (controlled && this.#active) {
        if (!game.combat?.started) this.#tracker.reset(token.id);
        this.#tokenId = token.id;
        this.draw(token);
      } else if (!controlled && this.#active && canvas.tokens.controlled.length === 0) {
        this.deactivate();
      }
    });
    Hooks.on("canvasReady", () => {
      this.#renderer.clear();
      this.refresh();
    });
    Hooks.on("canvasTearDown", () => this.#renderer.clear());
    this.#tracker.initialize();
  }

  toggle(): void {
    const token = canvas.tokens?.controlled[0];
    if (!token) {
      ui.notifications.info(game.i18n.localize("EGM.Notify.NoToken"));
      return;
    }

    if (this.#active && this.#tokenId === token.id) {
      this.deactivate();
      return;
    }

    if (!game.combat?.started) this.#tracker.reset(token.id);
    this.#active = true;
    this.#tokenId = token.id;
    this.draw(token);
  }

  deactivate(): void {
    this.#active = false;
    this.#plan = null;
    this.#tokenId = null;
    this.#renderer.clear();
  }

  refresh(changedTokenId?: string): void {
    if (this.#moving || !this.#active || !this.#tokenId) return;
    if (changedTokenId && changedTokenId !== this.#tokenId) return;
    const token = canvas.tokens?.get(this.#tokenId);
    if (token) this.draw(token);
    else this.deactivate();
  }

  draw(token: Token): void {
    if (!canvas.grid?.isSquare) {
      this.#renderer.clear();
      ui.notifications.warn(game.i18n.localize("EGM.Notify.UnsupportedGrid"));
      return;
    }

    const speed = this.#getWalkSpeed(token);
    if (speed <= 0) {
      this.#renderer.clear();
      ui.notifications.warn(game.i18n.localize("EGM.Notify.NoSpeed"));
      return;
    }

    const moved = this.#tracker.getMovedDistance(token);
    const remainingWalk = Math.max(0, speed - moved);
    const remainingDash = Math.max(0, speed * 2 - moved);
    if (remainingDash <= 0) {
      this.#plan = null;
      this.#renderer.clear();
      return;
    }

    this.#plan = this.calculatePlan(token, remainingWalk, remainingDash);
    this.#renderer.draw(this.#plan.walk, this.#plan.dash, {
      onHover: (key) => this.#showPreview(token, key),
      onLeave: () => this.#renderer.clearPreview(),
      onSelect: (key) => void this.moveTo(key),
    });
    this.#debug(
      `${token.name}: speed ${speed}, moved ${moved}, walk destinations ${this.#plan.walk.size}, ` +
        `dash destinations ${this.#plan.dash.size}.`,
    );
  }

  calculatePlan(token: Token, walkDistance: number, dashDistance: number): MovementPlan {
    const start = canvas.grid.getOffset({ x: token.document._source.x, y: token.document._source.y });
    const startKey = offsetKey(start);
    const adapter: ReachabilityAdapter = {
      getNeighbors: (offset) => canvas.grid.getAdjacentOffsets(offset),
      getPathCost: (path) => this.#measurePathCost(token, path),
      canOccupy: (offset) => offsetKey(offset) === startKey || this.#canOccupy(token, offset),
      canTraverse: (from, to) => this.#canTraverse(token, from, to),
    };
    const reachability = findReachability(start, dashDistance, adapter);
    return {
      tokenId: token.id,
      start,
      walk: cellsWithin(reachability.costs, walkDistance),
      dash: cellsWithin(reachability.costs, dashDistance),
      reachability,
      remainingWalk: walkDistance,
      remainingDash: dashDistance,
    };
  }

  async moveTo(destinationKey: string): Promise<void> {
    if (this.#moving || !this.#plan || !this.#tokenId) return;
    const token = canvas.tokens.get(this.#tokenId);
    const path = this.#plan.reachability.paths.get(destinationKey);
    const cost = this.#plan.reachability.costs.get(destinationKey);
    if (!token || !path || cost === undefined || path.length < 2) return;

    const waypoints = path.map((offset) => this.#waypoint(token, offset));
    const search = token.findMovementPath(waypoints, {
      preview: false,
      constrainOptions: { ignoreCost: true },
    });
    const constrainedPath = await search.promise;
    const destination = waypoints.at(-1);
    const final = constrainedPath.at(-1);
    if (!destination || !final || !this.#samePosition(destination, final)) {
      ui.notifications.warn(game.i18n.localize("EGM.Notify.PathBlocked"));
      this.refresh();
      return;
    }

    this.#moving = true;
    this.#renderer.clearPreview();
    this.#tracker.beginPlannedMove(token.id, cost);
    const origin = { x: token.document._source.x, y: token.document._source.y };
    const movementWaypoints = constrainedPath.slice(1).map((waypoint, index, all) => ({
      ...waypoint,
      checkpoint: index === all.length - 1,
    }));
    try {
      await canvas.scene.updateEmbeddedDocuments(
        "Token",
        [{ _id: token.id }],
        {
          method: "dragging",
          action: token.document.movementAction,
          terrainOptions: {},
          constrainOptions: { ignoreWalls: false, ignoreCost: false, ignoreTokens: false },
          measureOptions: {},
          movement: {
            [token.id]: {
              planned: false,
              waypoints: movementWaypoints,
            },
          },
        },
      );
      const destinationApplied = await this.#waitForPosition(token, destination, 5000);
      if (
        !destinationApplied ||
        (token.document._source.x === origin.x && token.document._source.y === origin.y)
      ) {
        this.#tracker.cancelPlannedMove(token.id);
        throw new Error("Foundry did not apply the requested token movement");
      }
      this.#tracker.finishPlannedMove(token.id);
    } catch (error) {
      this.#tracker.cancelPlannedMove(token.id);
      console.error("[Easy Grid Movement] Failed to move token", error);
      ui.notifications.error(game.i18n.localize("EGM.Notify.MoveFailed"));
    } finally {
      this.#moving = false;
      this.refresh();
      globalThis.setTimeout(() => this.refresh(), 500);
    }
  }

  #showPreview(token: Token, destinationKey: string): void {
    const path = this.#plan?.reachability.paths.get(destinationKey);
    const cost = this.#plan?.reachability.costs.get(destinationKey);
    if (!path || cost === undefined || !this.#plan) return;
    this.#renderer.showPreview({
      path: path.map((offset) => token.document.getMovementOrigin(this.#waypoint(token, offset))),
      cost,
      destination: parseOffsetKey(destinationKey),
      dash: cost > this.#plan.remainingWalk + 0.01,
    });
  }

  #measurePathCost(token: Token, path: readonly GridOffset[]): number {
    try {
      const waypoints = path.map((offset) => this.#waypoint(token, offset));
      const terrainPath = token.createTerrainMovementPath(waypoints, { preview: true });
      const measurement = token.measureMovementPath(terrainPath, { preview: true });
      return measurement.cost ?? measurement.distance;
    } catch (error) {
      this.#debug("Path measurement failed.", error);
      return Infinity;
    }
  }

  #canTraverse(token: Token, from: GridOffset, to: GridOffset): boolean {
    try {
      const destination = this.#waypoint(token, to);
      const [path, constrained] = token.constrainMovementPath(
        [this.#waypoint(token, from), destination],
        { preview: true, ignoreCost: true },
      );
      const final = path.at(-1);
      return !constrained && final !== undefined && this.#samePosition(destination, final);
    } catch (error) {
      this.#debug("Path collision test failed.", error);
      return false;
    }
  }

  #canOccupy(token: Token, offset: GridOffset): boolean {
    const waypoint = this.#waypoint(token, offset);
    if (!this.#isInsideScene(token, waypoint)) return false;
    const occupied = token.document.getOccupiedGridSpaceOffsets(waypoint);
    for (const other of canvas.tokens.placeables) {
      if (other.id === token.id || other.document.level !== waypoint.level) continue;
      if (!this.#elevationsOverlap(waypoint, other.document._source)) continue;
      const blocked = new Set(
        other.document.getOccupiedGridSpaceOffsets(other.document._source).map((space) => offsetKey(space)),
      );
      if (occupied.some((space) => blocked.has(offsetKey(space)))) return false;
    }
    return true;
  }

  #elevationsOverlap(first: MovementWaypoint, second: MovementWaypoint): boolean {
    const firstTop = first.elevation + first.depth * canvas.grid.distance;
    const secondTop = second.elevation + second.depth * canvas.grid.distance;
    return first.elevation < secondTop && second.elevation < firstTop;
  }

  #isInsideScene(token: Token, waypoint: MovementWaypoint): boolean {
    const center = token.document.getMovementOrigin(waypoint);
    return canvas.dimensions.rect.contains(center.x, center.y);
  }

  #waypoint(token: Token, offset: GridOffset): MovementWaypoint {
    const point = canvas.grid.getTopLeftPoint(offset);
    const source = token.document._source;
    return {
      x: point.x,
      y: point.y,
      elevation: source.elevation,
      width: source.width,
      height: source.height,
      depth: source.depth,
      shape: source.shape,
      level: source.level,
      action: token.document.movementAction,
      explicit: true,
      snapped: true,
      checkpoint: false,
    };
  }

  #samePosition(
    first: Pick<MovementWaypoint, "x" | "y">,
    second: Pick<MovementWaypoint, "x" | "y">,
  ): boolean {
    return Math.round(first.x) === Math.round(second.x) && Math.round(first.y) === Math.round(second.y);
  }

  async #waitForPosition(token: Token, destination: MovementWaypoint, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#samePosition(destination, token.document._source)) return true;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
    }
    const recordedDestination = token.document._movementHistory?.at(-1);
    return (
      this.#samePosition(destination, token.document._source) ||
      (recordedDestination !== undefined && this.#samePosition(destination, recordedDestination))
    );
  }

  #getWalkSpeed(token: Token): number {
    const value = token.actor?.system?.attributes?.movement?.walk;
    const speed = typeof value === "number" ? value : Number.parseFloat(String(value ?? 0));
    return Number.isFinite(speed) ? speed : 0;
  }

  #debug(message: string, ...details: unknown[]): void {
    if (game.settings.get(MODULE_ID, DEBUG_SETTING) === true) {
      console.debug(`[Easy Grid Movement] ${message}`, ...details);
    }
  }
}

export const easyGridMovement = new EasyGridMovement();
