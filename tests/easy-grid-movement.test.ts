import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MovementRendererHandlers } from "../src/renderer";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), clear: vi.fn(), clearPreview: vi.fn(), showPreview: vi.fn() }));
vi.mock("../src/renderer", () => ({ MovementRenderer: class {
  draw = renderer.draw;
  clear = renderer.clear;
  clearPreview = renderer.clearPreview;
  showPreview = renderer.showPreview;
} }));
import { EasyGridMovement } from "../src/easy-grid-movement";

function handlers(): MovementRendererHandlers {
  return renderer.draw.mock.lastCall?.[4] as MovementRendererHandlers;
}

describe("movement interaction", () => {
  let movement: EasyGridMovement;
  let token: Token;
  let update: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const source: MovementWaypoint = { x: 0, y: 0, elevation: 0, width: 1, height: 1, depth: 1, shape: 0, level: "ground" };
    token = {
      id: "token", name: "Test token",
      document: {
        id: "token", ...source, inCombat: false, movementAction: "fly", detectionModes: {}, _source: source,
        getCenterPoint: (p = source) => ({ x: p.x! + 50, y: p.y! + 50 }),
        getMovementOrigin: (p = source) => ({ x: p.x!, y: p.y! }),
        getOccupiedGridSpaceOffsets: (p = source) => [{ i: p.y! / 100, j: p.x! / 100 }],
      },
      actor: { system: { attributes: { movement: { walk: 10, fly: 30 } } } },
      _getDragWaypointPosition: (current, changes) => ({ ...current, ...changes }),
      checkCollision: () => false,
      constrainMovementPath: (path) => [path, false],
      createTerrainMovementPath: (path) => path,
      findMovementPath: (path) => ({ result: path, promise: Promise.resolve(path), cancel() {} }),
      measureMovementPath: (path) => {
        let cost = 0;
        const waypoints = path.map((p, i) => {
          const previous = path[i - 1];
          if (previous) cost += Math.max(Math.abs(p.x - previous.x) / 100 * 5, Math.abs(p.y - previous.y) / 100 * 5, Math.abs(p.elevation - previous.elevation));
          return { cost, distance: cost };
        });
        return { cost, distance: cost, waypoints };
      },
    };
    update = vi.fn((_type, _documents, options: { movement: Record<string, { waypoints: MovementWaypoint[] }> }) => {
      Object.assign(source, options.movement.token!.waypoints.at(-1));
      return Promise.resolve([]);
    });
    vi.stubGlobal("game", { settings: { get: () => false }, i18n: { localize: (s: string) => s } });
    vi.stubGlobal("CONFIG", { DND5E: { movementTypes: { walk: {}, fly: {}, burrow: {}, swim: { walkFallback: true }, climb: { walkFallback: true } } }, Canvas: { elevationSnappingPrecision: 4 } });
    vi.stubGlobal("ui", { notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    vi.stubGlobal("canvas", {
      grid: {
        isSquare: true, size: 100, distance: 5,
        getOffset: (p: Point) => ({ i: p.y / 100, j: p.x / 100 }),
        getTopLeftPoint: (p: GridOffset) => ({ x: p.j * 100, y: p.i * 100 }),
        getAdjacentOffsets: (p: GridOffset) => [{ i: p.i, j: p.j + 1 }, { i: p.i, j: p.j - 1 }, { i: p.i + 1, j: p.j }, { i: p.i - 1, j: p.j }],
      },
      tokens: { controlled: [token], placeables: [token], get: () => token },
      dimensions: { distance: 5, rect: { contains: (x: number, y: number) => x >= 0 && y >= 0 && x <= 1000 && y <= 1000 } },
      visibility: { tokenVision: false },
      scene: { updateEmbeddedDocuments: update },
    });
    movement = new EasyGridMovement();
    movement.toggle();
  });

  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("uses the selected flying speed for the normal range", () => {
    const walk = renderer.draw.mock.lastCall?.[0] as Set<string>;
    expect(walk.has("0,6")).toBe(true);
    expect(walk.has("0,7")).toBe(false);
  });

  it("Ctrl-click pins a waypoint without moving the token", async () => {
    // Exercise the same callback as a grid click, including its modifier.
    handlers().onSelect("0,2", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(update).not.toHaveBeenCalled();
    expect(token.document._source.x).toBe(0);
  });

  it("commits the whole pinned route on a plain click, including a return toward the origin", async () => {
    await movement.addWaypoint("0,2");
    await movement.addWaypoint("2,2");
    handlers().onSelect("2,0", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(1);
    const options = update.mock.lastCall?.[2] as { movement: Record<string, { waypoints: MovementWaypoint[] }> };
    const path = options.movement.token!.waypoints;
    expect(path.filter(p => p.checkpoint).map(p => [p.x, p.y])).toEqual([[200, 0], [200, 200], [0, 200]]);
    expect(path.every(p => p.action === "fly")).toBe(true);
    expect(token.document._source).toMatchObject({ x: 0, y: 200 });
  });

  it("right-click removes one waypoint at a time and then closes the interface", async () => {
    await movement.addWaypoint("0,2");
    await movement.addWaypoint("2,2");
    handlers().onCancel();
    expect(movement.active).toBe(true);
    expect(renderer.showPreview.mock.lastCall?.[0]).toMatchObject({ cost: 10, waypoints: [{ x: 250, y: 50 }] });
    handlers().onCancel();
    expect(movement.active).toBe(true);
    handlers().onCancel();
    expect(movement.active).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("subtracts pinned movement from the range and keeps the pinned route on pointer leave", async () => {
    await movement.addWaypoint("0,4");
    const walk = renderer.draw.mock.lastCall?.[0] as Set<string>;
    expect(walk.has("2,4")).toBe(true);
    expect(walk.has("3,4")).toBe(false);
    handlers().onLeave();
    expect(renderer.showPreview.mock.lastCall?.[0]).toMatchObject({ cost: 20 });
  });

  it("retains waypoint elevations in subsequent legs", async () => {
    handlers().onHover("0,2");
    handlers().onElevation("0,2", -120, false);
    await movement.addWaypoint("0,2");
    await movement.addWaypoint("2,2");
    await movement.moveTo("2,3");
    expect(token.document._source).toMatchObject({ x: 300, y: 200, elevation: 5 });
  });

  it("cannot revive a canceled asynchronous waypoint", async () => {
    const pending = movement.addWaypoint("0,2");
    movement.removeWaypoint();
    await pending;
    expect(movement.active).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a pinned route if a saved leg becomes blocked before commit", async () => {
    await movement.addWaypoint("0,2");
    token.constrainMovementPath = (path) => [path.slice(0, 1), true];
    await movement.moveTo("2,2");
    expect(update).not.toHaveBeenCalled();
    expect(ui.notifications.warn).toHaveBeenCalledWith("EGM.Notify.PathBlocked");
  });

  it("does not substitute walking speed when flying speed is zero", () => {
    token.actor!.system!.attributes!.movement!.fly = 0;
    renderer.draw.mockClear();
    movement.refresh();
    expect(renderer.draw).not.toHaveBeenCalled();
    expect(ui.notifications.warn).toHaveBeenCalledWith("EGM.Notify.NoSpeed");
  });

  it("uses the system's walking fallback for swimming", () => {
    token.document.movementAction = "swim";
    movement.refresh();
    const walk = renderer.draw.mock.lastCall?.[0] as Set<string>;
    expect(walk.has("0,2")).toBe(true);
    expect(walk.has("0,3")).toBe(false);
  });

  it("measures alternating diagonal costs across waypoint boundaries", async () => {
    canvas.grid.getAdjacentOffsets = p => [-1, 0, 1].flatMap(i => [-1, 0, 1]
      .filter(j => i !== 0 || j !== 0).map(j => ({ i: p.i + i, j: p.j + j })));
    token.measureMovementPath = path => {
      let cost = 0;
      let diagonals = 0;
      const waypoints = path.map((p, index) => {
        const from = path[index - 1];
        if (from) {
          const x = Math.abs(p.x - from.x) / 100;
          const y = Math.abs(p.y - from.y) / 100;
          const diagonal = Math.min(x, y);
          cost += (Math.max(x, y) + Math.floor((diagonals + diagonal) / 2) - Math.floor(diagonals / 2)) * 5;
          diagonals += diagonal;
        }
        return { cost, distance: cost };
      });
      return { cost, distance: cost, waypoints };
    };
    movement.refresh();
    await movement.addWaypoint("1,1");
    await movement.addWaypoint("2,2");
    expect(renderer.showPreview.mock.lastCall?.[0]).toMatchObject({ cost: 15 });
  });

  it("plain click still moves immediately without a waypoint", async () => {
    handlers().onSelect("0,2", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledTimes(1);
    expect(token.document._source).toMatchObject({ x: 200, y: 0 });
  });

  it("charges movement for a planned route that returns to its starting square", async () => {
    await movement.addWaypoint("0,2");
    await movement.moveTo("0,0");
    const walk = renderer.draw.mock.lastCall?.[0] as Set<string>;
    expect(walk.has("0,2")).toBe(true);
    expect(walk.has("0,3")).toBe(false);
  });
});
