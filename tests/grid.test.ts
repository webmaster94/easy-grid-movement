import { describe, expect, it } from "vitest";
import {
  cellsWithin,
  expandToFootprint,
  findReachableCosts,
  findReachability,
  offsetKey,
  type GridOffset,
  type ReachabilityAdapter,
} from "../src/grid";

const orthogonalNeighbors = ({ i, j }: GridOffset): GridOffset[] => [
  { i: i - 1, j },
  { i: i + 1, j },
  { i, j: j - 1 },
  { i, j: j + 1 },
];

function adapter(blocked = new Set<string>()): ReachabilityAdapter {
  return {
    getNeighbors: orthogonalNeighbors,
    getPathCost: (path) => (path.length - 1) * 5,
    canOccupy: ({ i, j }) => i >= 0 && i < 5 && j >= 0 && j < 5,
    canTraverse: (_from, to) => !blocked.has(offsetKey(to)),
  };
}

describe("findReachableCosts", () => {
  it("finds all cells within the measured budget", () => {
    const costs = findReachableCosts({ i: 2, j: 2 }, 10, adapter());
    expect(costs.size).toBe(13);
    expect(costs.get("2,2")).toBe(0);
    expect(costs.get("0,2")).toBe(10);
    expect(costs.has("0,0")).toBe(false);
  });

  it("does not traverse blocked cells", () => {
    const costs = findReachableCosts({ i: 0, j: 0 }, 10, adapter(new Set(["0,1", "1,0"])));
    expect([...costs.keys()]).toEqual(["0,0"]);
  });

  it("separates walking and dashing ranges from one search", () => {
    const costs = findReachableCosts({ i: 2, j: 2 }, 10, adapter());
    expect(cellsWithin(costs, 5).size).toBe(5);
    expect(cellsWithin(costs, 10).size).toBe(13);
  });

  it("retains the cheapest complete path for hover previews and movement", () => {
    const expensive = "0,1";
    const result = findReachability(
      { i: 0, j: 0 },
      30,
      {
        getNeighbors: orthogonalNeighbors,
        getPathCost: (path) =>
          path.slice(1).reduce((cost, offset) => cost + (offsetKey(offset) === expensive ? 25 : 5), 0),
        canOccupy: ({ i, j }) => i >= 0 && i < 3 && j >= 0 && j < 3,
        canTraverse: () => true,
      },
    );

    expect(result.costs.get("0,2")).toBe(20);
    expect(result.paths.get("0,2")?.map(offsetKey)).toEqual(["0,0", "1,0", "1,1", "1,2", "0,2"]);
  });
});

describe("expandToFootprint", () => {
  it("expands anchors by token width across columns and height across rows", () => {
    expect([...expandToFootprint(new Set(["3,7"]), 2, 3)].sort()).toEqual([
      "3,7",
      "3,8",
      "4,7",
      "4,8",
      "5,7",
      "5,8",
    ]);
  });
});
