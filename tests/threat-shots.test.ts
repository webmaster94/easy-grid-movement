import { describe, expect, it } from "vitest";
import { groupThreatShots, type ShotTarget } from "../src/threat-shots";

const target = (id: string, x: number, y: number): ShotTarget => ({ id, x, y, width: 100, height: 100 });
const viewport = { width: 1000, height: 500 };

describe("enemy camera grouping", () => {
  it("frames twelve nearby enemies in one shot including their reveal margins", () => {
    const targets = Array.from({ length: 12 }, (_, i) => target(String(i), (i % 4) * 100, Math.floor(i / 4) * 100));
    const shots = groupThreatShots(targets, 600, 100, viewport);
    expect(shots).toHaveLength(1); expect(shots[0]!.ids).toHaveLength(12);
    const camera = shots[0]!.view;
    for (const t of targets) {
      expect((Math.abs(t.x - camera.x) + t.width / 2 + 100) * camera.scale).toBeLessThanOrEqual(viewport.width / 2);
      expect((Math.abs(t.y - camera.y) + t.height / 2 + 100) * camera.scale).toBeLessThanOrEqual(viewport.height / 2);
    }
  });
  it("uses separate shots for distant clusters, without transitive grouping of a long chain", () => {
    const targets = [target("a", 0, 0), target("b", 100, 0), target("c", 1000, 0), target("d", 1100, 0)];
    expect(groupThreatShots(targets, 600, 100, viewport).map(s => s.ids)).toEqual([["a", "b"], ["c", "d"]]);
    const chain = Array.from({ length: 12 }, (_, i) => target(String(i), i * 300, 0));
    const shots = groupThreatShots(chain, 600, 100, viewport);
    expect(shots.length).toBeGreaterThan(1);
    for (const shot of shots) {
      const xs = shot.ids.map(id => chain[Number(id)]!.x);
      expect(Math.max(...xs) - Math.min(...xs) + 100).toBeLessThanOrEqual(600);
    }
  });
  it("honors the grouping threshold and includes each enemy once", () => {
    const targets = [target("a", 0, 0), target("b", 400, 0), target("a", 0, 0)];
    expect(groupThreatShots(targets, 300, 100, viewport)).toHaveLength(2);
    expect(groupThreatShots(targets, 600, 100, viewport)[0]!.ids).toEqual(["a", "b"]);
    expect(groupThreatShots([], 600, 100, viewport)).toEqual([]);
  });
});
