import { describe, expect, it } from "vitest";
import { stepElevation } from "../src/elevation";

describe("stepElevation", () => {
  it("raises on wheel-up and lowers on wheel-down", () => {
    expect(stepElevation(0, -120, 5)).toBe(5);
    expect(stepElevation(0, 120, 5)).toBe(-5);
  });

  it("moves to the next directional interval from an unsnapped elevation", () => {
    expect(stepElevation(12, -120, 5)).toBe(15);
    expect(stepElevation(12, 120, 5)).toBe(10);
  });

  it("supports Foundry's precise fractional interval", () => {
    expect(stepElevation(0, -1, 1.25)).toBe(1.25);
    expect(stepElevation(1.25, 1, 1.25)).toBe(0);
  });
});
