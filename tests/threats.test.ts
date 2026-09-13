import { afterEach, describe, expect, it, vi } from "vitest";
import { rangeBand, weaponRanges, type RangedWeapon } from "../src/threats";

function bow(): RangedWeapon {
  return { type: "weapon", system: { equipped: true, quantity: 1, range: { value: 80, long: 320, units: "ft" },
    activities: [{ type: "attack", attack: { type: { value: "ranged", classification: "weapon" } } }] } };
}

afterEach(() => vi.unstubAllGlobals());
describe("ranged weapon threats", () => {
  it("reads short and long range and uses inclusive boundaries", () => {
    const ranges = weaponRanges([bow()], "ft");
    expect(ranges).toEqual([{ short: 80, long: 320 }]);
    expect([80, 85, 320, 325].map(distance => rangeBand(ranges, distance))).toEqual(["short", "long", "long", null]);
  });
  it("excludes spells, melee-only attacks, unequipped and exhausted weapons", () => {
    const spell = bow(); spell.type = "spell";
    const melee = bow(); melee.system.activities = [{ type: "attack", attack: { type: { value: "melee", classification: "weapon" } } }];
    const spellActivity = bow(); spellActivity.system.activities = [{ type: "attack", attack: { type: { value: "ranged", classification: "spell" } } }];
    const unequipped = bow(); unequipped.system.equipped = false;
    const exhausted = bow(); exhausted.system.quantity = 0;
    expect(weaponRanges([spell, melee, spellActivity, unequipped, exhausted], "ft")).toEqual([]);
  });
  it("honors ranged modes on thrown weapons and per-activity range overrides", () => {
    const thrown = bow(); thrown.system.activities = [{ type: "attack", attack: { type: { value: "melee", classification: "weapon" } },
      validAttackTypes: new Set(["melee", "ranged"]), range: { override: true, value: 20, units: "ft" } }];
    expect(weaponRanges([thrown], "ft")).toEqual([{ short: 20, long: 20 }]);
  });
  it("uses the most dangerous applicable weapon and converts metric scene units", () => {
    expect(rangeBand([{ short: 10, long: 60 }, { short: 30, long: 30 }], 25)).toBe("short");
    expect(weaponRanges([bow()], "m")).toEqual([{ short: 24, long: 96 }]);
  });
  it("rejects nonnumeric and unsupported ranges", () => {
    const malformed = bow(); malformed.system.range = { value: "@abilities.dex.mod", long: 20, units: "ft" };
    expect(weaponRanges([malformed], "ft")).toEqual([]);
    expect(weaponRanges([bow()], "hexes")).toEqual([]);
  });
});
