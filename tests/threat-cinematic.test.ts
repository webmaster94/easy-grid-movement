import { afterEach, describe, expect, it, vi } from "vitest";
import { FoundryCinematicView, ThreatCinematic, type CinematicView } from "../src/threat-cinematic";

function setup() {
  vi.useFakeTimers();
  const release = vi.fn();
  const original = { x: 10, y: 20, scale: .6 };
  const view = {
    scene: vi.fn(() => "scene"), camera: () => original,
    shots: (ids: readonly string[]) => ids.map(id => ({ ids: [id], view: { x: Number(id), y: 100, scale: 1.5 } })),
    pan: vi.fn<CinematicView["pan"]>().mockResolvedValue(undefined), stopPan: vi.fn(),
    banner: vi.fn(), hideBanner: vi.fn(), spotlight: vi.fn(() => release),
    highlight: vi.fn(), clearHighlights: vi.fn(), reducedMotion: () => false,
  } satisfies CinematicView;
  return { cinematic: new ThreatCinematic(view), view, release, original };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("threat camera sequence", () => {
  it("visits each enemy once, cleans each reveal, and restores the exact original camera", async () => {
    const { cinematic, view, release, original } = setup();
    const done = cinematic.play(["1", "2", "1"], () => true);
    expect(view.banner).toHaveBeenCalledWith(false);
    await vi.runAllTimersAsync(); await done;
    expect(view.spotlight.mock.calls).toEqual([["1"], ["2"]]);
    expect(release).toHaveBeenCalledTimes(2);
    expect(view.pan).toHaveBeenLastCalledWith(original, 650);
    expect(view.hideBanner).toHaveBeenCalledOnce();
    expect(cinematic.playing).toBe(false);
  });
  it("cancels during a reveal, clears it, and returns immediately", async () => {
    const { cinematic, view, release, original } = setup();
    const done = cinematic.play(["1", "2"], () => true);
    await vi.advanceTimersByTimeAsync(800);
    cinematic.clear(); await done;
    expect(view.stopPan).toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(view.spotlight).toHaveBeenCalledTimes(1);
    expect(view.clearHighlights).toHaveBeenCalled();
    expect(view.pan).toHaveBeenLastCalledWith(original, 0);
  });
  it("does not apply the old camera position after a scene switch", async () => {
    const { cinematic, view } = setup();
    const done = cinematic.play(["1"], () => true);
    view.scene.mockReturnValue("new-scene"); cinematic.cancel(); await done;
    expect(view.pan).not.toHaveBeenCalled();
    expect(view.hideBanner).toHaveBeenCalled();
  });
  it("restores the camera and releases a spotlight if panning fails", async () => {
    const { cinematic, view, release, original } = setup();
    view.pan.mockRejectedValueOnce(new Error("pan failed"));
    const done = expect(cinematic.play(["1"], () => true)).rejects.toThrow("pan failed");
    await vi.runAllTimersAsync(); await done;
    expect(release).toHaveBeenCalledOnce();
    expect(view.hideBanner).toHaveBeenCalledOnce();
    expect(view.pan).toHaveBeenLastCalledWith(original, 650);
    expect(cinematic.playing).toBe(false);
  });
});

describe("temporary Foundry reveal", () => {
  function setupReveal(fail = false) {
    class Graphic {
      children: Graphic[] = [];
      destroyed = false;
      parent: Graphic | null = null;
      addChild(child: Graphic) { this.children.push(child); child.parent = this; return child; }
      destroy() {
        this.destroyed = true;
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
        for (const child of [...this.children]) child.destroy();
      }
      beginFill() { return this; }
      endFill() { return this; }
      drawCircle() { return this; }
      lineStyle() { if (fail) throw new Error("render failed"); return this; }
    }
    const parents = [new Graphic(), new Graphic(), new Graphic()];
    const shared = parents.map(parent => parent.addChild(new Graphic()));
    const grid = new Graphic();
    vi.stubGlobal("PIXI", { Container: Graphic, Graphics: Graphic });
    vi.stubGlobal("canvas", {
      tokens: { get: () => ({ document: { hidden: false, width: 1, height: 1, getCenterPoint: () => ({ x: 50, y: 50 }) } }) },
      grid: { size: 100 }, interface: { grid }, masks: { vision: { renderDirty: false } },
      visibility: { vision: { sight: { preview: parents[0] }, light: { preview: parents[1], mask: { preview: parents[2] } } } },
    });
    return { view: new FoundryCinematicView(), parents, shared, grid };
  }
  it("removes only its own reveal graphics and tolerates repeated cleanup", () => {
    const { view, parents, shared, grid } = setupReveal();
    const release = view.spotlight("enemy");
    expect(parents.map(p => p.children.length)).toEqual([2, 2, 2]);
    release(); release();
    expect(parents.map(p => p.children.length)).toEqual([1, 1, 1]);
    expect(shared.every(g => !g.destroyed)).toBe(true);
    expect(grid.children).toHaveLength(0);
  });
  it("yields the camera to manual navigation without rewinding that navigation", async () => {
    const { cinematic, view, release } = setup();
    const done = cinematic.play(["1", "2"], () => true);
    await vi.advanceTimersByTimeAsync(800);
    cinematic.releaseCamera(); await done;
    expect(view.pan).toHaveBeenCalledTimes(1);
    expect(view.stopPan).toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(view.clearHighlights).not.toHaveBeenCalled();
  });
  it("reveals every member of a group together for a single camera shot", async () => {
    const { cinematic, view, release } = setup();
    view.shots = () => [{ ids: ["1", "2"], view: { x: 150, y: 100, scale: 1 } }];
    const done = cinematic.play(["1", "2"], () => true);
    await vi.advanceTimersByTimeAsync(800);
    expect(view.spotlight).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    expect(view.pan).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync(); await done;
    expect(release).toHaveBeenCalledTimes(2);
    expect(view.pan).toHaveBeenCalledTimes(2);
  });
  it("cleans a partially constructed reveal if rendering throws", () => {
    const { view, parents, shared, grid } = setupReveal(true);
    expect(() => view.spotlight("enemy")).toThrow("render failed");
    expect(parents.map(p => p.children.length)).toEqual([1, 1, 1]);
    expect(shared.every(g => !g.destroyed)).toBe(true);
    expect(grid.children).toHaveLength(0);
  });
});
