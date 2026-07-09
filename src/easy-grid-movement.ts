import { DEBUG_SETTING, MODULE_ID } from "./constants";
import {
  cellsWithin,
  expandToFootprint,
  findReachableCosts,
  type GridOffset,
  type ReachabilityAdapter,
} from "./grid";
import { MovementTracker } from "./movement-tracker";
import { MovementRenderer } from "./renderer";

interface MovementRanges {
  walk: Set<string>;
  dash: Set<string>;
}

export class EasyGridMovement {
  readonly #renderer = new MovementRenderer();
  readonly #tracker = new MovementTracker((tokenId) => this.refresh(tokenId));
  #active = false;
  #initialized = false;
  #tokenId: string | null = null;

  get active(): boolean {
    return this.#active;
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

    this.#active = true;
    this.#tokenId = token.id;
    this.draw(token);
  }

  deactivate(): void {
    this.#active = false;
    this.#tokenId = null;
    this.#renderer.clear();
  }

  refresh(changedTokenId?: string): void {
    if (!this.#active || !this.#tokenId) return;
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

    const moved = this.#tracker.getMovedDistance(token.id);
    const remainingWalk = Math.max(0, speed - moved);
    const remainingDash = Math.max(0, speed * 2 - moved);
    if (remainingDash <= 0) {
      this.#renderer.clear();
      return;
    }

    const ranges = this.calculateRanges(token, remainingWalk, remainingDash);
    this.#renderer.draw(ranges.walk, ranges.dash);
    this.#debug(
      `${token.name}: speed ${speed}, moved ${moved}, walk cells ${ranges.walk.size}, dash cells ${ranges.dash.size}.`,
    );
  }

  calculateRanges(token: Token, walkDistance: number, dashDistance: number): MovementRanges {
    const document = token.document;
    const width = Math.max(1, Math.ceil(document.width));
    const height = Math.max(1, Math.ceil(document.height));
    const start = canvas.grid.getOffset({ x: document.x, y: document.y });
    const center = (offset: GridOffset): Point => {
      const topLeft = canvas.grid.getTopLeftPoint(offset);
      return document.getCenterPoint({ x: topLeft.x, y: topLeft.y });
    };

    const adapter: ReachabilityAdapter = {
      getNeighbors: (offset) => canvas.grid.getAdjacentOffsets(offset),
      getStepCost: (from, to) => canvas.grid.measurePath([center(from), center(to)]).distance,
      canOccupy: (offset) => this.#isInsideScene(offset, width, height),
      canTraverse: (from, to) =>
        !token.checkCollision(center(to), { origin: center(from), type: "move", mode: "any" }),
    };
    const costs = findReachableCosts(start, dashDistance, adapter);
    const walkAnchors = cellsWithin(costs, walkDistance);
    const dashAnchors = cellsWithin(costs, dashDistance);
    return {
      walk: expandToFootprint(walkAnchors, width, height),
      dash: expandToFootprint(dashAnchors, width, height),
    };
  }

  #isInsideScene(offset: GridOffset, width: number, height: number): boolean {
    const point = canvas.grid.getTopLeftPoint(offset);
    const dimensions = canvas.dimensions;
    return (
      point.x >= dimensions.sceneX &&
      point.y >= dimensions.sceneY &&
      point.x + width * canvas.grid.size <= dimensions.sceneX + dimensions.sceneWidth &&
      point.y + height * canvas.grid.size <= dimensions.sceneY + dimensions.sceneHeight
    );
  }

  #getWalkSpeed(token: Token): number {
    const value = token.actor?.system?.attributes?.movement?.walk;
    const speed = typeof value === "number" ? value : Number.parseFloat(String(value ?? 0));
    return Number.isFinite(speed) ? speed : 0;
  }

  #debug(message: string): void {
    if (game.settings.get(MODULE_ID, DEBUG_SETTING) === true) {
      console.debug(`[Easy Grid Movement] ${message}`);
    }
  }
}

export const easyGridMovement = new EasyGridMovement();
