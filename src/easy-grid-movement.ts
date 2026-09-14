import { CINEMATIC_GROUP_DISTANCE_SETTING, CINEMATIC_THREATS_SETTING, CONFIRM_DASH_SETTING, DEBUG_SETTING, DETECT_THREATS_SETTING, MODULE_ID } from "./constants";
import { ThreatCinematic } from "./threat-cinematic";
import { ThreatDetector } from "./threats";
import { DashController, movementTurnKey, type DashReservation } from "./dash";
import { stepElevation } from "./elevation";
import {
  cellsWithin,
  reachabilitySteps,
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
  readonly #dash = new DashController();
  readonly #threats = new ThreatDetector();
  readonly #cinematic = new ThreatCinematic();
  #interrupted: { path: MovementWaypoint[]; turn: string; action: string; known: Set<string> } | null = null;
  readonly #tracker = new MovementTracker(
    (tokenId) => this.refresh(tokenId),
    (tokenId) => this.#active && tokenId === this.#tokenId,
  );
  #drawRequestId = 0;
  #sightTimer: ReturnType<typeof setTimeout> | null = null;
  whenReady: Promise<void> = Promise.resolve();
  #active = false;
  #initialized = false;
  #moving = false;
  #plan: MovementPlan | null = null;
  #previewDestinationKey: string | null = null;
  #previewElevation: number | null = null;
  #previewRequestId = 0;
  #tokenId: string | null = null;
  #waypoints: ResolvedMovementPath[] = [];
  #editing = false;
  #editRequestId = 0;
  #origin: MovementWaypoint | null = null;

  get active(): boolean {
    return this.#active;
  }

  get moving(): boolean {
    return this.#moving;
  }

  initialize(): void {
    if (this.#initialized) return;
    this.#initialized = true;

    game.settings.register(MODULE_ID, CINEMATIC_THREATS_SETTING, {
      name: game.i18n.localize("EGM.Settings.CinematicThreatsName"),
      hint: game.i18n.localize("EGM.Settings.CinematicThreatsHint"),
      scope: "user", config: true, type: Boolean, default: true, requiresReload: false,
      onChange: () => this.#cinematic.cancel(),
    });
    game.settings.register(MODULE_ID, CINEMATIC_GROUP_DISTANCE_SETTING, {
      name: game.i18n.localize("EGM.Settings.CinematicGroupDistanceName"),
      hint: game.i18n.localize("EGM.Settings.CinematicGroupDistanceHint"),
      scope: "user", config: true, type: Number, default: 6, range: { min: 2, max: 20, step: 1 }, requiresReload: false,
    });
    game.settings.register(MODULE_ID, DETECT_THREATS_SETTING, {
      name: game.i18n.localize("EGM.Settings.DetectThreatsName"),
      hint: game.i18n.localize("EGM.Settings.DetectThreatsHint"),
      scope: "user", config: true, type: Boolean, default: false, requiresReload: false,
      onChange: () => { this.#cinematic.clear(); this.#interrupted = null; this.refresh(); },
    });

    game.settings.register(MODULE_ID, CONFIRM_DASH_SETTING, {
      name: game.i18n.localize("EGM.Settings.ConfirmDashName"),
      hint: game.i18n.localize("EGM.Settings.ConfirmDashHint"),
      scope: "user", config: true, type: Boolean, default: true, requiresReload: false,
    });

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
        this.#cinematic.clear();
        this.#interrupted = null;
        if (!game.combat?.started) { this.#tracker.reset(token.id); this.#dash.reset(token.id); }
        this.#tokenId = token.id;
        this.#clearWaypoints();
        this.draw(token);
      } else if (!controlled && this.#active && canvas.tokens.controlled.length === 0) {
        this.deactivate();
      }
    });
    Hooks.on("canvasReady", () => {
      this.#renderer.clear();
      this.refresh();
    });
    Hooks.on("sightRefresh", () => {
      if (this.#moving || !this.#active || this.#sightTimer !== null) return;
      this.#sightTimer = globalThis.setTimeout(() => {
        this.#sightTimer = null;
        const token = this.#tokenId ? canvas.tokens.get(this.#tokenId) : null;
        if (token && this.#plan && !this.#moving) {
          if (this.#updateVisibleCells(token, this.#plan)) {
            this.#resetDestinationPreview();
            this.#displayPlan(token, this.#plan);
          }
        }
      }, 75);
    });
    for (const hook of ["createWall", "updateWall", "deleteWall", "createRegion", "updateRegion", "deleteRegion",
      "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior", "createToken", "deleteToken"] as const) {
      Hooks.on(hook, () => this.refresh());
    }
    Hooks.on("canvasTearDown", () => this.deactivate());
    Hooks.on("updateToken", (document, changes) => {
      if (["movementAction", "width", "height", "depth", "shape", "level"].some(key => key in changes)) this.refresh();
      else if (document.id !== this.#tokenId && ["x", "y", "elevation", "width", "height", "depth", "level"].some(key => key in changes)) this.refresh();
    });
    Hooks.on("updateActor", () => this.refresh());
    for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"] as const) {
      Hooks.on(hook, () => this.refresh());
    }
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

    if (!game.combat?.started) { this.#tracker.reset(token.id); this.#dash.reset(token.id); }
    this.#active = true;
    this.#tokenId = token.id;
    this.draw(token);
  }

  deactivate(): void {
    this.#cinematic.clear();
    this.#drawRequestId += 1;
    if (this.#sightTimer !== null) globalThis.clearTimeout(this.#sightTimer);
    this.#sightTimer = null;
    this.#interrupted = null;
    this.#active = false;
    this.#plan = null;
    this.#clearWaypoints();
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
    const requestId = ++this.#drawRequestId;
    if (this.#interrupted && (!this.#samePosition(this.#interrupted.path[0]!, token.document._source)
      || this.#interrupted.turn !== movementTurnKey() || this.#interrupted.action !== token.document.movementAction)) {
      this.#interrupted = null;
      this.#cinematic.clear();
    }
    if (this.#origin && !this.#samePosition(this.#origin, token.document._source)) this.#clearWaypoints();
    this.#origin = { ...token.document._source };
    this.#plan = null;
    this.#resetDestinationPreview();
    if (!canvas.grid?.isSquare) {
      this.#renderer.clear();
      ui.notifications.warn(game.i18n.localize("EGM.Notify.UnsupportedGrid"));
      return;
    }

    const speed = this.#getMovementSpeed(token);
    if (speed <= 0) {
      this.#renderer.clear();
      ui.notifications.warn(game.i18n.localize("EGM.Notify.NoSpeed"));
      return;
    }

    const moved = this.#tracker.getMovedDistance(token);
    const bonus = this.#dash.bonus(token);
    const remainingWalk = Math.max(0, speed + bonus - moved);
    const remainingDash = Math.max(0, speed * 2 + bonus - moved);
    const remainingOver = Math.max(0, speed * 3 + bonus - moved);
    if (remainingOver <= 0 && !this.#interrupted) {
      this.#plan = null;
      this.#renderer.clear();
      return;
    }

    if (this.#interrupted) {
      // The only pending destination is the saved route. Search fresh ranges after cancel/continue.
      this.#plan = {
        tokenId: token.id, start: canvas.grid.getOffset(token.document._source),
        walk: new Set(), dash: new Set(), over: new Set(), difficult: new Set(),
        reachability: { costs: new Map(), paths: new Map() },
        remainingWalk, remainingDash, remainingOver,
      };
      this.#displayPlan(token, this.#plan);
      this.whenReady = Promise.resolve();
      return;
    }

    this.#renderer.clear(true);
    const search = this.#calculatePlan(token, remainingWalk, remainingDash, remainingOver);
    // Bound each search slice so animation, zoom, and cancellation remain responsive.
    this.whenReady = new Promise<void>((resolve) => {
      const advance = (): void => {
        if (requestId !== this.#drawRequestId) { resolve(); return; }
        const deadline = performance.now() + 8;
        let result = search.next();
        while (!result.done && performance.now() < deadline) result = search.next();
        if (!result.done) { globalThis.setTimeout(advance, 0); return; }
        this.#plan = result.value;
        this.#displayPlan(token, this.#plan);
        resolve();
      };
      advance();
    });
  }

  #displayPlan(token: Token, plan: MovementPlan): void {
    const targets = new Set(plan.over);
    if (this.#interrupted) targets.add(offsetKey(canvas.grid.getOffset(this.#interrupted.path.at(-1)!)));
    this.#renderer.draw(plan.walk, plan.dash, targets, new Set([...plan.difficult].filter(key => plan.dash.has(key))), {
      onHover: (key) => this.#hoverDestination(token, key),
      onLeave: () => this.#leaveDestination(token),
      onElevation: (key, wheelDelta, precise) =>
        this.#adjustPreviewElevation(token, key, wheelDelta, precise),
      onSelect: (key, waypoint) => void (waypoint ? this.addWaypoint(key) : this.moveTo(key)),
      onCancel: () => this.removeWaypoint(),
      onNavigate: () => this.#cinematic.releaseCamera(),
    });
    const pinned = this.#waypoints.at(-1);
    if (pinned) this.#renderPreview(token, pinned, plan);
    if (this.#interrupted) this.#renderPreview(token, this.#resolvedPath(token, this.#interrupted.path, true), plan);
  }

  calculatePlan(
    token: Token,
    walkDistance: number,
    dashDistance: number,
    overDistance = dashDistance,
  ): MovementPlan {
    const search = this.#calculatePlan(token, walkDistance, dashDistance, overDistance);
    let result = search.next();
    while (!result.done) result = search.next();
    return result.value;
  }

  *#calculatePlan(token: Token, walkDistance: number, dashDistance: number, overDistance: number): Generator<void, MovementPlan> {
    const start = canvas.grid.getOffset(this.#planningOrigin(token));
    const plannedCost = this.#waypoints.at(-1)?.cost ?? 0;
    const startKey = offsetKey(start);
    const difficult = new Set<string>();
    const origin = this.#planningOrigin(token);
    const blocked = new Set<string>();
    for (const other of canvas.tokens.placeables) {
      if (other.id === token.id || other.document.level !== origin.level
        || !this.#elevationsOverlap(origin, other.document._source)) continue;
      for (const space of other.document.getOccupiedGridSpaceOffsets(other.document._source)) blocked.add(offsetKey(space));
    }
    const waypoints = new Map<string, MovementWaypoint>();
    const waypoint = (offset: GridOffset): MovementWaypoint => {
      const key = offsetKey(offset);
      let point = waypoints.get(key);
      if (!point) { point = this.#waypoint(token, offset); waypoints.set(key, point); }
      return point;
    };
    const adapter: ReachabilityAdapter = {
      getNeighbors: (offset) => canvas.grid.getAdjacentOffsets(offset),
      getPathCost: (path) => {
        const measurement = this.#measurePath(token, path.map(waypoint));
        const destination = path.at(-1);
        if (destination) {
          const key = offsetKey(destination);
          if (measurement.difficult) difficult.add(key);
          else difficult.delete(key);
        }
        return measurement.cost;
      },
      canOccupy: (offset) => offsetKey(offset) === startKey || this.#canOccupy(token, waypoint(offset), blocked),
      canTraverse: (from, to) => this.#canTraverse(token, waypoint(from), waypoint(to)),
    };
    const reachability = yield* reachabilitySteps(start, overDistance, adapter);
    const walkRange = cellsWithin(reachability.costs, walkDistance - plannedCost);
    const dashRange = cellsWithin(reachability.costs, dashDistance - plannedCost);
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
      difficult,
      reachability,
      remainingWalk: walkDistance,
      remainingDash: dashDistance,
      remainingOver: overDistance,
    };
  }

  #updateVisibleCells(token: Token, plan: MovementPlan): boolean {
    const visible = new Set([...plan.reachability.costs.keys()].filter(key => this.#canSeeCell(token, key)));
    if (visible.size === plan.over.size && [...visible].every(key => plan.over.has(key))) return false;
    const plannedCost = this.#waypoints.at(-1)?.cost ?? 0;
    plan.over = visible;
    plan.walk = new Set([...plan.over].filter(key => plan.reachability.costs.get(key)! <= plan.remainingWalk - plannedCost + 0.01));
    plan.dash = new Set([...plan.over].filter(key => plan.reachability.costs.get(key)! <= plan.remainingDash - plannedCost + 0.01));
    return true;
  }

  async moveTo(destinationKey: string): Promise<void> {
    if (this.#moving || this.#editing || !this.#plan || !this.#tokenId) return;
    const plan = this.#plan;
    const token = canvas.tokens.get(this.#tokenId);
    const interrupted = this.#interrupted;
    if (interrupted?.path.length === 1) { this.#cinematic.clear(); this.#interrupted = null; this.refresh(); return; }
    const path = this.#plan.reachability.paths.get(destinationKey);
    if (!token || (!path && !interrupted)) return;
    const elevation =
      this.#previewDestinationKey === destinationKey && this.#previewElevation !== null
        ? this.#previewElevation
        : this.#planningOrigin(token).elevation;
    this.#moving = true;
    let moveStarted = false;
    let dash: DashReservation | null = null;
    let completed = false;
    let remainder: MovementWaypoint[] | null = null;
    let detected: string[] = [];
    const origin = { ...token.document._source };
    const action = token.document.movementAction;
    const speed = this.#getMovementSpeed(token);
    const turn = movementTurnKey();
    const isCurrent = (): boolean => this.#active && plan === this.#plan && turn === movementTurnKey()
      && action === token.document.movementAction && speed === this.#getMovementSpeed(token)
      && this.#samePosition(origin, token.document._source);
    try {
      const resolve = async (): Promise<ResolvedMovementPath | null> => {
        if (!interrupted) return this.#resolveMovementPath(token, path!, elevation, false);
        if (!this.#checkSavedPath(token, interrupted.path)) return null;
        const resolved = this.#resolvedPath(token, interrupted.path, false);
        return Number.isFinite(resolved.cost) ? resolved : null;
      };
      const prepare = (full: ResolvedMovementPath): ResolvedMovementPath => {
        const discovery = this.#threats.firstDiscovery(token, full.movementPath, interrupted?.known);
        remainder = discovery?.remainder ?? null;
        detected = discovery?.enemyIds ?? [];
        return discovery ? this.#resolvedPath(token, discovery.path, false) : full;
      };
      const full = await resolve();
      if (!isCurrent()) return;
      if (!full) {
        ui.notifications.warn(game.i18n.localize("EGM.Notify.PathBlocked"));
        return;
      }
      let resolved = prepare(full);
      if (resolved.cost <= 0.01 && this.#samePosition(token.document._source, resolved.destination)) return;
      if (resolved.cost > plan.remainingWalk + 0.01) {
        dash = await this.#dash.reserve(token, speed, resolved.cost > plan.remainingDash + 0.01, isCurrent);
        if (!dash || !isCurrent()) return;
        // The dialog can remain open while the scene changes. Recheck the complete route.
        const rechecked = await resolve();
        const checked = rechecked ? prepare(rechecked) : null;
        if (!isCurrent()) return;
        if (!checked || Math.abs(checked.cost - resolved.cost) > 0.01 || !this.#samePosition(checked.destination, resolved.destination)) {
          ui.notifications.warn(game.i18n.localize("EGM.Notify.PathBlocked"));
          return;
        }
        resolved = checked;
      }
      this.#renderer.clearPreview();
      this.#tracker.beginPlannedMove(token.id, resolved.cost);
      moveStarted = true;
      const descending = resolved.movementPath.some((waypoint, index, all) =>
        index > 0 && waypoint.elevation < all[index - 1]!.elevation - 0.01);
      const movementWaypoints = resolved.movementPath.slice(1).map((waypoint, index, all) => ({
        ...waypoint,
        checkpoint: waypoint.checkpoint || index === all.length - 1,
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
      const returnsToOrigin = this.#samePosition(resolved.destination, origin);
      if (!destinationApplied || (!returnsToOrigin && this.#samePosition(token.document._source, origin))) {
        this.#tracker.cancelPlannedMove(token.id);
        moveStarted = false;
        throw new Error("Foundry did not apply the requested token movement");
      }
      this.#tracker.finishPlannedMove(token.id);
      completed = true;
      this.#clearWaypoints();
      const known = new Set([...(interrupted?.known ?? []), ...detected]);
      this.#interrupted = remainder ? { path: remainder, turn, action, known } : null;
      // Document coordinates commit before the rendered token and its vision reach the endpoint.
      // Keep refresh hooks suspended until the native animation has finished.
      await token.movementAnimationPromise;
      if (remainder && this.#active && this.#tokenId === token.id && this.#threats.enabled) {
        this.#cinematic.highlight([...known]);
        if (game.settings.get(MODULE_ID, CINEMATIC_THREATS_SETTING) !== false) {
          try {
            this.draw(token);
            await this.#cinematic.play(detected, () => this.#active && this.#tokenId === token.id
              && movementTurnKey() === turn && this.#threats.enabled);
          } catch (error) {
            console.error("[Easy Grid Movement] Threat cinematic failed", error);
            ui.notifications.info(game.i18n.localize("EGM.Threats.Detected"));
          }
        } else ui.notifications.info(game.i18n.localize("EGM.Threats.Detected"));
      } else this.#cinematic.clear();
      moveStarted = false;
    } catch (error) {
      if (moveStarted) this.#tracker.cancelPlannedMove(token.id);
      console.error("[Easy Grid Movement] Failed to move token", error);
      ui.notifications.error(game.i18n.localize("EGM.Notify.MoveFailed"));
    } finally {
      try {
        if (!completed) await dash?.rollback();
      } catch (error) {
        console.error("[Easy Grid Movement] Failed to return the Dash action", error);
        ui.notifications.error(game.i18n.localize("EGM.Notify.DashRefundFailed"));
      }
      this.#moving = false;
      this.#resetDestinationPreview();
      this.refresh();
    }
  }

  async addWaypoint(destinationKey: string): Promise<void> {
    if (this.#moving || this.#editing || !this.#plan || !this.#tokenId) return;
    if (this.#interrupted) return;
    const token = canvas.tokens.get(this.#tokenId);
    const plan = this.#plan;
    const path = plan.reachability.paths.get(destinationKey);
    if (!token || !path) return;
    const elevation = this.#previewDestinationKey === destinationKey && this.#previewElevation !== null
      ? this.#previewElevation : this.#planningOrigin(token).elevation;
    const requestId = ++this.#editRequestId;
    this.#editing = true;
    try {
      const resolved = await this.#resolveMovementPath(token, path, elevation, true);
      if (requestId !== this.#editRequestId || plan !== this.#plan || !this.#active) return;
      if (!resolved) {
        ui.notifications.warn(game.i18n.localize("EGM.Notify.PathBlocked"));
        return;
      }
      if (this.#samePosition(this.#planningOrigin(token), resolved.destination)) return;
      resolved.movementPath.at(-1)!.checkpoint = true;
      this.#waypoints.push(resolved);
      this.draw(token);
    } catch (error) {
      this.#debug("Waypoint planning failed.", error);
      ui.notifications.warn(game.i18n.localize("EGM.Notify.PathBlocked"));
    } finally {
      if (requestId === this.#editRequestId) this.#editing = false;
    }
  }

  removeWaypoint(): void {
    if (this.#cinematic.playing) {
      this.#cinematic.clear(); this.#interrupted = null; this.#clearWaypoints();
      return;
    }
    if (this.#moving) return;
    if (this.#interrupted) {
      this.#cinematic.clear();
      this.#interrupted = null;
      this.#clearWaypoints();
      this.refresh();
      return;
    }
    this.#editRequestId += 1;
    this.#editing = false;
    if (!this.#waypoints.length) {
      this.deactivate();
      return;
    }
    this.#waypoints.pop();
    this.refresh();
  }

  #clearWaypoints(): void {
    this.#waypoints = [];
    this.#editRequestId += 1;
    this.#editing = false;
    this.#origin = null;
  }

  #planningOrigin(token: Token): MovementWaypoint {
    return this.#waypoints.at(-1)?.destination ?? token.document._source;
  }

  #leaveDestination(token: Token): void {
    if (this.#interrupted) return;
    this.#resetDestinationPreview();
    const pinned = this.#waypoints.at(-1);
    if (pinned && this.#plan) this.#renderPreview(token, pinned, this.#plan);
  }

  #hoverDestination(token: Token, destinationKey: string): void {
    if (this.#interrupted) return;
    if (destinationKey !== this.#previewDestinationKey) {
      this.#previewDestinationKey = destinationKey;
      this.#previewElevation = this.#planningOrigin(token).elevation;
    }
    void this.#showPreview(token, destinationKey);
  }

  #adjustPreviewElevation(
    token: Token,
    destinationKey: string,
    wheelDelta: number,
    precise: boolean,
  ): void {
    if (this.#interrupted) return;
    if (!this.#plan?.reachability.paths.has(destinationKey)) return;
    if (destinationKey !== this.#previewDestinationKey) {
      this.#previewDestinationKey = destinationKey;
      this.#previewElevation = this.#planningOrigin(token).elevation;
    }
    const precision = precise ? Math.max(1, CONFIG.Canvas.elevationSnappingPrecision) : 1;
    const interval = canvas.dimensions.distance / precision;
    const current = this.#previewElevation ?? this.#planningOrigin(token).elevation;
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
    if (this.#moving) return;
    const elevation = this.#previewElevation ?? this.#planningOrigin(token).elevation;
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
    this.#renderPreview(token, resolved, plan);
  }

  #renderPreview(token: Token, resolved: ResolvedMovementPath, plan: MovementPlan): void {
    const elevation = resolved.destination.elevation;
    this.#renderer.showPreview({
      path: resolved.terrainPath.map((waypoint) => token.document.getCenterPoint(waypoint)),
      waypoints: this.#waypoints.map((waypoint) => token.document.getCenterPoint(waypoint.destination)),
      segmentBands: resolved.measurement.waypoints.slice(1).map((waypoint) =>
        movementBand(waypoint.cost, plan.remainingWalk, plan.remainingDash),
      ),
      difficultSegments: resolved.terrainPath.slice(1).map((waypoint) =>
        Boolean(waypoint.terrain?.difficultTerrain),
      ),
      cost: resolved.cost,
      destination: canvas.grid.getOffset(resolved.destination),
      footprint: {
        width: token.document._source.width,
        height: token.document._source.height,
      },
      elevation,
      elevationDelta: elevation - token.document._source.elevation,
      destinationBand: movementBand(resolved.cost, plan.remainingWalk, plan.remainingDash),
      threats: this.#threats.preview(token, resolved.destination),
      enemiesDetected: this.#interrupted !== null,
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
    const origin = this.#planningOrigin(token);
    const descending = elevation < origin.elevation - 0.01;
    const pathDestination = descending
      ? { ...destination, elevation: origin.elevation }
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
    const segment = descending
      ? [...foundPath, { ...destination, explicit: false, snapped: false }]
      : foundPath;
    const prefix = this.#waypoints.at(-1)?.movementPath ?? [];
    // Recheck saved legs before committing; a wall or occupied cell may have changed.
    if (!preview && !this.#checkSavedPath(token, prefix)) return null;
    const movementPath = prefix.length ? [...prefix, ...segment.slice(1)] : segment;
    const resolved = this.#resolvedPath(token, movementPath, preview);
    return Number.isFinite(resolved.cost) ? resolved : null;
  }

  #checkSavedPath(token: Token, path: readonly MovementWaypoint[]): boolean {
    for (let index = 1; index < path.length; index++) {
      const from = path[index - 1]!, to = path[index]!;
      const descent = to.elevation < from.elevation && this.#samePosition(
        { x: from.x, y: from.y }, { x: to.x, y: to.y });
      const [checked, constrained] = token.constrainMovementPath([from, to], {
        preview: false, ignoreCost: true, ignoreWalls: descent, ignoreTokens: false,
      });
      if (constrained || !checked.at(-1) || !this.#samePosition(to, checked.at(-1)!)) return false;
    }
    return true;
  }

  #resolvedPath(token: Token, movementPath: MovementWaypoint[], preview: boolean): ResolvedMovementPath {
    const terrainPath = token.createTerrainMovementPath(movementPath, { preview });
    const measurement = token.measureMovementPath(terrainPath, { preview });
    const cost = measurement.cost ?? measurement.distance;
    return { destination: movementPath.at(-1)!, movementPath, terrainPath, measurement, cost };
  }

  #resetDestinationPreview(): void {
    this.#previewRequestId += 1;
    this.#previewDestinationKey = null;
    this.#previewElevation = null;
    this.#renderer.clearPreview();
  }

  #measurePath(token: Token, suffix: MovementWaypoint[]): PathMeasurement {
    try {
      const pinned = this.#waypoints.at(-1);
      const waypoints = pinned ? [...pinned.movementPath, ...suffix.slice(1)] : suffix;
      const terrainPath = token.createTerrainMovementPath(waypoints, { preview: true });
      const measurement = token.measureMovementPath(terrainPath, { preview: true });
      return {
        cost: (measurement.cost ?? measurement.distance) - (pinned?.cost ?? 0),
        difficult: Boolean(terrainPath.at(-1)?.terrain?.difficultTerrain),
      };
    } catch (error) {
      this.#debug("Path measurement failed.", error);
      return { cost: Infinity, difficult: false };
    }
  }

  #canTraverse(token: Token, from: MovementWaypoint, destination: MovementWaypoint): boolean {
    try {
      const [path, constrained] = token.constrainMovementPath(
        [from, destination],
        { preview: true, ignoreCost: true },
      );
      const final = path.at(-1);
      return !constrained && final !== undefined && this.#samePosition(destination, final);
    } catch (error) {
      this.#debug("Path collision test failed.", error);
      return false;
    }
  }

  #canOccupy(token: Token, waypoint: MovementWaypoint, blocked: ReadonlySet<string>): boolean {
    return this.#isInsideScene(token, waypoint)
      && !token.document.getOccupiedGridSpaceOffsets(waypoint).some(space => blocked.has(offsetKey(space)));
  }

  #canSeeCell(token: Token, key: string): boolean {
    if (!canvas.visibility.tokenVision) return true;
    try {
      const visionSource = token.vision;
      if (!visionSource?.active) return false;
      const point = canvas.grid.getTopLeftPoint(parseOffsetKey(key));
      const size = canvas.grid.size;
      const elevation = this.#planningOrigin(token).elevation;
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
    const origin = this.#planningOrigin(token);
    if (offsetKey(canvas.grid.getOffset(origin)) === offsetKey(offset)) {
      return { ...origin, action: token.document.movementAction };
    }
    const point = canvas.grid.getTopLeftPoint(offset);
    const source = token.document._source;
    return {
      x: point.x,
      y: point.y,
      elevation: this.#planningOrigin(token).elevation,
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

  #getMovementSpeed(token: Token): number {
    const movement = token.actor?.system?.attributes?.movement;
    const action = token.document.movementAction;
    const numericSpeed = (value: unknown): number => {
      const speed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : 0;
      return Number.isFinite(speed) ? Math.max(0, speed) : 0;
    };
    const speed = numericSpeed(movement?.[action]);
    const type = CONFIG.DND5E?.movementTypes[action];
    // Match the system ruler, leaving action-specific cost multipliers to Foundry.
    return type?.walkFallback || (!type && !["fly", "burrow"].includes(action))
      ? Math.max(speed, numericSpeed(movement?.walk)) : speed;
  }

  #debug(message: string, ...details: unknown[]): void {
    if (game.settings.get(MODULE_ID, DEBUG_SETTING) === true) {
      console.debug(`[Easy Grid Movement] ${message}`, ...details);
    }
  }
}

export const easyGridMovement = new EasyGridMovement();
