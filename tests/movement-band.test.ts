import { describe, expect, it } from "vitest";
import { movementBand } from "../src/movement-band";

describe("movementBand", () => {
  it("classifies the complete measured cost at movement thresholds", () => {
    expect(movementBand(30, 30, 60)).toBe("walk");
    expect(movementBand(35, 30, 60)).toBe("dash");
    expect(movementBand(65, 30, 60)).toBe("over");
  });

  it("tolerates Foundry measurement rounding at a threshold", () => {
    expect(movementBand(30.009, 30, 60)).toBe("walk");
    expect(movementBand(60.009, 30, 60)).toBe("dash");
  });
});
