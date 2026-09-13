import { afterEach, describe, expect, it, vi } from "vitest";
import { MovementRenderer } from "../src/renderer";

class Graphics {
  static all: Graphics[] = [];
  events = new Map<string, (...args: unknown[]) => void>();
  constructor() { Graphics.all.push(this); }
  beginFill = vi.fn(() => this);
  endFill = vi.fn(() => this);
  lineStyle = vi.fn(() => this);
  drawCircle = vi.fn(() => this);
  drawRect = vi.fn(() => this);
  moveTo = vi.fn(() => this);
  lineTo = vi.fn(() => this);
  clear = vi.fn(() => this);
  on(event: string, callback: (...args: unknown[]) => void) { this.events.set(event, callback); return this; }
}

function setup() {
  Graphics.all = [];
  const listeners = new Map<string, (event: unknown) => void>();
  vi.stubGlobal("window", {
    addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  vi.stubGlobal("document", { elementFromPoint: () => ({ id: "board" }) });
  vi.stubGlobal("PIXI", {
    Container: class { addChild() {} destroy() {} }, Graphics,
    Text: class { anchor = { set() {} }; position = { set() {} }; },
  });
  vi.stubGlobal("canvas", {
    interface: { grid: { interactiveChildren: false, addChild() {}, addHighlightLayer: () => new Graphics(), destroyHighlightLayer() {} } },
    grid: { size: 100, getTopLeftPoint: () => ({ x: 0, y: 0 }) }, scene: { grid: { units: "ft" } },
  });
  const handlers = { onHover: vi.fn(), onLeave: vi.fn(), onSelect: vi.fn(), onCancel: vi.fn(), onElevation: vi.fn() };
  const renderer = new MovementRenderer();
  renderer.draw(new Set(), new Set(), new Set(["0,0"]), new Set(), handlers);
  Graphics.all.find(g => g.events.has("pointerover"))!.events.get("pointerover")!();
  return { renderer, handlers, listeners };
}

afterEach(() => vi.unstubAllGlobals());

describe("movement overlay controls", () => {
  it("leaves ordinary wheel events untouched and reserves Shift-wheel for elevation", () => {
    const { renderer, handlers, listeners } = setup();
    const event = { clientX: 0, clientY: 0, deltaY: 120, shiftKey: false, altKey: false,
      preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    listeners.get("wheel")!(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(handlers.onElevation).not.toHaveBeenCalled();
    listeners.get("wheel")!({ ...event, shiftKey: true });
    expect(handlers.onElevation).toHaveBeenCalledWith("0,0", 120, false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    listeners.get("wheel")!({ ...event, shiftKey: true, altKey: true });
    expect(handlers.onElevation).toHaveBeenLastCalledWith("0,0", 120, true);
    renderer.clear(); expect(listeners.size).toBe(0);
  });

  it("draws threat rays as dots while the movement route stays continuous", () => {
    const { renderer } = setup();
    renderer.showPreview({ path: [{ x: 0, y: 0 }, { x: 200, y: 0 }], waypoints: [],
      segmentBands: ["walk"], difficultSegments: [false], cost: 10, destination: { i: 0, j: 2 },
      footprint: { width: 1, height: 1 }, elevation: 0, elevationDelta: 0, destinationBand: "walk",
      threats: [{ tokenId: "enemy", band: "short", from: { x: 100, y: 100 }, to: { x: 200, y: 0 },
        bounds: { x: 50, y: 50, width: 100, height: 100 } }],
    });
    const movement = Graphics.all[1]!, threats = Graphics.all[2]!;
    expect(threats.drawCircle.mock.calls.length).toBeGreaterThan(3);
    expect(threats.lineTo).not.toHaveBeenCalled();
    expect(threats.beginFill).toHaveBeenCalledWith(0xff3333, 1);
    expect(movement.lineTo).toHaveBeenCalled();
  });
});
