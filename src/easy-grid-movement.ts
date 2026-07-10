import { DEBUG_SETTING, MODULE_ID } from "./constants";
import { stepElevation } from "./elevation";
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
import { movementBand } from "./movement-band";
import { MovementRenderer } from "./renderer";

export interface MovementPlan {
  tokenId: string;
  start: GridOffset;
  walk: Set<string>;
  dash: Set<string>;
  over: Set<string>;
  difficult: Set<string>;
  reachability: ReachabilityResult;
  remainingWalk: number;
  remainingDash: number;
  remainingOver: number;
}

interface PathMeasurement {
  cost: number;
  difficult: boolean;
}

interface ResolvedMovementPath {
  destination: MovementWaypoint;
  movementPath: MovementWaypoint[];
  terrainPath: MovementWaypoint[];
  measurement: MovementMeasurement;
  cost: number;
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
  #previewDestinationKey: string | null = null;
  #previewElevation: number | null = null;
  #previewRequestId = 0;
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
    Hooks.on("sightRefresh", () => this.refresh());
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
    this.#resetDestinationPreview();
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
    const remainingOver = Math.max(0, speed * 3 - moved);
    if (remainingOver <= 0) {
      this.#plan = null;
      this.#renderer.clear();
      return;
    }

    this.#plan = this.calculatePlan(token, remainingWalk, remainingDash, remainingOver);
    this.#renderer.draw(this.#plan.walk, this.#plan.dash, this.#plan.over, this.#plan.difficult, {
      onHover: (key) => this.#hoverDestination(token, key),
      onLeave: () => this.#resetDestinationPreview(),
      onElevation: (key, wheelDelta, precise) =>
        this.#adjustPreviewElevation(token, key, wheelDelta, precise),
      onSelect: (key) => void this.moveTo(key),
    });
    this.#debug(
      `${token.name}: speed ${speed}, moved ${moved}, walk destinations ${this.#plan.walk.size}, ` +
        `dash destinations ${this.#plan.dash.size}, over-range destinations ${this.#plan.over.size}.`,
    );
  }

  calculatePlan(
    token: Token,
    walkDistance: number,
    dashDistance: number,
    overDistance = dashDistance,
  ): MovementPlan {
    const start = canvas.grid.getOffset({ x: token.document._source.x, y: token.document._source.y });
    const startKey = offsetKey(start);
    const difficult = new Set<string>();
    const adapter: ReachabilityAdapter = {
      getNeighbors: (offset) => canvas.grid.getAdjacentOffsets(offset),
      getPathCost: (path) => {
        const measurement = this.#measurePath(token, path);
        const destination = path.at(-1);
        if (destination) {
          const key = offsetKey(destination);
          if (measurement.difficult) difficult.add(key);
          else difficult.delete(key);
        }
        return measurement.cost;
      },
      canOccupy: (offset) => offsetKey(offset) === startKey || this.#canOccupy(token, offset),
      canTraverse: (from, to) => this.#canTraverse(token, from, to),
    };
    const reachability = findReachability(start, overDistance, adapter);
    const walkRange = cellsWithin(reachability.costs, walkDistance);
    const dashRange = cellsWithin(reachability.costs, dashDistance);
    const overRange = cellsWithin(reachability.costs, overDistance);
    const visible = new Set([...overRange].filter((key) => this.#canSeeCell(token, key)));
    const walk = new Set([...walkRange].filter((key) => visible.has(key)));
    const dash = new Set([...dashRange].filter((key) => visible.has(key)));
    const over = visible;
    return {
      tokenId: token.id,
      start,
      walk,
      dash,
      over,
      difficult: new Set([...difficult].filter((key) => dash.has(key))),
      reachability,
      remainingWalk: walkDistance,
      remainingDash: dashDistance,
      remainingOver: overDistance,
    };
  }

  async moveTo(destinationKey: string): Promise<void> {
    if (this.#moving || !this.#plan || !this.#tokenId) return;
    const token = canvas.tokens.get(this.#tokenId);
    const path = this.#plan.reachability.paths.get(destinationKey);
    if (!token || !path) return;
    const elevation =
      this.#previewDestinationKey === destinationKey && this.#previewElevation !== null
        ? this.#previewElevation
        : token.document._source.elevation;
    this.#moving = true;
    let moveStarted = false;
    try {
      const resolved = await this.#resolveMovementPath(token, path, elevation, false);
      if (!resolved) {
        ui.notifications.warn(game.i18n.localize("EGM.Notify.PathBlocked"));
        return;
      }
      if (resolved.cost <= 0.01 && this.#samePosition(token.document._source, resolved.destination)) return;
      this.#renderer.clearPreview();
      this.#tracker.beginPlannedMove(token.id, resolved.cost);
      moveStarted = true;
      const descending = resolved.destination.elevation < token.document._source.elevation - 0.01;
      const origin = {
        x: token.document._source.x,
        y: token.document._source.y,
        elevation: token.document._source.elevation,
      };
      const movementWaypoints = resolved.movementPath.slice(1).map((waypoint, index, all) => ({
        ...waypoint,
        checkpoint: index === all.length - 1,
      }));
      await canvas.scene.updateEmbeddedDocuments(
        "Token",
        [{ _id: token.id }],
        {
          method: "dragging",
          action: token.document.movementAction,
          terrainOptions: {},
          // The horizontal path was just wall-checked by #resolveMovementPath. Foundry otherwise
          // truncates a downward endpoint at the current floor and applies only the horizontal part.
          constrainOptions: { ignoreWalls: descending, ignoreCost: false, ignoreTokens: false },
          measureOptions: {},
          movement: {
            [token.id]: {
              planned: false,
              waypoints: movementWaypoints,
            },
          },
        },
      );
      const destinationApplied = await this.#waitForPosition(token, resolved.destination, 5000);
      if (!destinationApplied || this.#samePosition(token.document._source, origin)) {
        this.#tracker.cancelPlannedMove(token.id);
        moveStarted = false;
        throw new Error("Foundry did not apply the requested token movement");
      }
      this.#tracker.finishPlannedMove(token.id);
      moveStarted = false;
    } catch (error) {
      if (moveStarted) this.#tracker.cancelPlannedMove(token.id);
      console.error("[Easy Grid Movement] Failed to move token", error);
      ui.notifications.error(game.i18n.localize("EGM.Notify.MoveFailed"));
    } finally {
      this.#moving = false;
      this.#resetDestinationPreview();
      this.refresh();
      globalThis.setTimeout(() => this.refresh(), 500);
    }
  }

  #hoverDestination(token: Token, destinationKey: string): void {
    if (destinationKey !== this.#previewDestinationKey) {
      this.#previewDestinationKey = destinationKey;
      this.#previewElevation = token.document._source.elevation;
    }
    void this.#showPreview(token, destinationKey);
  }

  #adjustPreviewElevation(
    token: Token,
    destinationKey: string,
    wheelDelta: number,
    precise: boolean,
  ): void {
    if (!this.#plan?.reachability.paths.has(destinationKey)) return;
    if (destinationKey !== this.#previewDestinationKey) {
      this.#previewDestinationKey = destinationKey;
      this.#previewElevation = token.document._source.elevation;
    }
    const precision = precise ? Math.max(1, CONFIG.Canvas.elevationSnappingPrecision) : 1;
    const interval = canvas.dimensions.distance / precision;
    const current = this.#previewElevation ?? token.document._source.elevation;
    const elevation = stepElevation(current, wheelDelta, interval);
    const destination = token._getDragWaypointPosition(
      this.#waypoint(token, parseOffsetKey(destinationKey)),
      { elevation },
      { snap: true },
    );
    this.#previewElevation = destination.elevation;
    void this.#showPreview(token, destinationKey);
  }

  async #showPreview(token: Token, destinationKey: string): Promise<void> {
    const plan = this.#plan;
    const path = plan?.reachability.paths.get(destinationKey);
    if (!path || !plan) return;
    const elevation = this.#previewElevation ?? token.document._source.elevation;
    const requestId = ++this.#previewRequestId;
    let resolved: ResolvedMovementPath | null;
    try {
      resolved = await this.#resolveMovementPath(token, path, elevation, true);
    } catch (error) {
      this.#debug("Elevation-aware path preview failed.", error);
      if (requestId === this.#previewRequestId) this.#renderer.clearPreview();
      return;
    }
    if (
      !resolved ||
      requestId !== this.#previewRequestId ||
      destinationKey !== this.#previewDestinationKey ||
      plan !== this.#plan
    ) {
      if (requestId === this.#previewRequestId) this.#renderer.clearPreview();
      return;
    }
    this.#renderer.showPreview({
      path: resolved.terrainPath.map((waypoint) => token.document.getCenterPoint(waypoint)),
      segmentBands: resolved.measurement.waypoints.slice(1).map((waypoint) =>
        movementBand(waypoint.cost, plan.remainingWalk, plan.remainingDash),
      ),
      difficultSegments: resolved.terrainPath.slice(1).map((waypoint) =>
        Boolean(waypoint.terrain?.difficultTerrain),
      ),
      cost: resolved.cost,
      destination: parseOffsetKey(destinationKey),
      footprint: {
        width: token.document._source.width,
        height: token.document._source.height,
      },
      elevation,
      elevationDelta: elevation - token.document._source.elevation,
      destinationBand: movementBand(resolved.cost, plan.remainingWalk, plan.remainingDash),
    });
  }

  async #resolveMovementPath(
    token: Token,
    path: readonly GridOffset[],
    elevation: number,
    preview: boolean,
  ): Promise<ResolvedMovementPath | null> {
    const waypoints = path.map((offset) => this.#waypoint(token, offset));
    const last = waypoints.at(-1);
    if (!last) return null;
    const destination = { ...last, elevation };
    const descending = elevation < token.document._source.elevation - 0.01;
    const pathDestination = descending
      ? { ...destination, elevation: token.document._source.elevation }
      : destination;
    if (waypoints.length === 1) waypoints.push(pathDestination);
    else waypoints[waypoints.length - 1] = pathDestination;

    const search = token.findMovementPath(waypoints, {
      preview,
      constrainOptions: { ignoreCost: true, ignoreWalls: false, ignoreTokens: false },
    });
    const foundPath = await search.promise;
    const final = foundPath.at(-1);
    if (!final || !this.#samePosition(pathDestination, final)) return null;
    const movementPath = descending
      ? [...foundPath, { ...destination, explicit: false, snapped: false }]
      : foundPath;
    const terrainPath = token.createTerrainMovementPath(movementPath, { preview });
    const measurement = token.measureMovementPath(terrainPath, { preview });
    const cost = measurement.cost ?? measurement.distance;
    if (!Number.isFinite(cost)) return null;
    return { destination, movementPath, terrainPath, measurement, cost };
  }

  #resetDestinationPreview(): void {
    this.#previewRequestId += 1;
    this.#previewDestinationKey = null;
    this.#previewElevation = null;
    this.#renderer.clearPreview();
  }

  #measurePath(token: Token, path: readonly GridOffset[]): PathMeasurement {
    try {
      const waypoints = path.map((offset) => this.#waypoint(token, offset));
      const terrainPath = token.createTerrainMovementPath(waypoints, { preview: true });
      const measurement = token.measureMovementPath(terrainPath, { preview: true });
      return {
        cost: measurement.cost ?? measurement.distance,
        difficult: Boolean(terrainPath.at(-1)?.terrain?.difficultTerrain),
      };
    } catch (error) {
      this.#debug("Path measurement failed.", error);
      return { cost: Infinity, difficult: false };
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

  #canSeeCell(token: Token, key: string): boolean {
    if (!canvas.visibility.tokenVision) return true;
    try {
      const visionSource = token.vision;
      if (!visionSource?.active) return false;
      const point = canvas.grid.getTopLeftPoint(parseOffsetKey(key));
      const size = canvas.grid.size;
      const elevation = token.document._source.elevation;
      const config = canvas.visibility._createVisibilityTestConfig(
        [{ x: point.x + size / 2, y: point.y + size / 2, elevation }],
        { tolerance: 0 },
      );
      for (const id of ["basicSight", "lightPerception"]) {
        const mode = token.document.detectionModes[id];
        const detectionMode = CONFIG.Canvas.detectionModes[id];
        if (mode && detectionMode?.testVisibility(visionSource, mode, config)) return true;
      }
      return false;
    } catch (error) {
      this.#debug("Visibility test failed.", error);
      return false;
    }
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
    first: Pick<MovementWaypoint, "x" | "y"> & Partial<Pick<MovementWaypoint, "elevation">>,
    second: Pick<MovementWaypoint, "x" | "y"> & Partial<Pick<MovementWaypoint, "elevation">>,
  ): boolean {
    return (
      Math.round(first.x) === Math.round(second.x) &&
      Math.round(first.y) === Math.round(second.y) &&
      (first.elevation === undefined ||
        second.elevation === undefined ||
        Math.abs(first.elevation - second.elevation) < 0.01)
    );
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
