import { DETECT_THREATS_SETTING, MODULE_ID } from "./constants";

export interface WeaponRange { short: number; long: number }
export type RangedWeapon = RangedWeaponData;

export interface Threat {
  tokenId: string;
  from: Point;
  to: Point;
  bounds: { x: number; y: number; width: number; height: number };
  band: "short" | "long";
}

// D&D 5e uses a five-foot square as 1.5 metres. Match its length conversion.
const units: Record<string, number> = { ft: 1, feet: 1, foot: 1, m: 1 / 0.3, meter: 1 / 0.3,
  meters: 1 / 0.3, metres: 1 / 0.3, mi: 5280, km: 1000 / 0.3 };

export function weaponRanges(items: Iterable<RangedWeapon>, sceneUnits: string): WeaponRange[] {
  const result: WeaponRange[] = [];
  for (const item of items) {
    if (item.type !== "weapon" || item.system.equipped === false || item.system.quantity === 0) continue;
    for (const activity of item.system.activities ?? []) {
      if (activity.type !== "attack" || activity.attack?.type?.classification !== "weapon") continue;
      if (!(activity.validAttackTypes?.has("ranged") ?? (activity.attack.type.value === "ranged"))) continue;
      const range = activity.range?.override ? activity.range : item.system.range;
      if (!range) continue;
      const from = units[(range.units ?? "ft").toLowerCase()];
      const to = units[sceneUnits.toLowerCase()];
      if (!from || !to) continue;
      const short = Number(range.value) * from / to;
      const long = Math.max(short, Number(range.long ?? range.value) * from / to);
      if (Number.isFinite(short) && short > 0 && Number.isFinite(long)) result.push({ short, long });
    }
  }
  return result;
}

export function rangeBand(ranges: readonly WeaponRange[], distance: number): Threat["band"] | null {
  if (ranges.some(range => distance <= range.short + 0.01)) return "short";
  return ranges.some(range => distance <= range.long + 0.01) ? "long" : null;
}

export interface ThreatDiscovery { path: MovementWaypoint[]; remainder: MovementWaypoint[] }

export class ThreatDetector {
  get enabled(): boolean { return game.settings.get(MODULE_ID, DETECT_THREATS_SETTING) === true; }

  #enemies(token: Token): Array<{ token: Token; ranges: WeaponRange[] }> {
    const disposition = token.document.disposition ?? 0;
    return canvas.tokens.placeables.flatMap(enemy => {
      // Opposing friendly/hostile dispositions only. Secret and neutral dispositions are not enemies.
      if (enemy.id === token.id || ![-1, 1].includes(disposition)
        || enemy.document.disposition !== -disposition || enemy.document.hidden
        || enemy.actor?.statuses?.has("dead") || enemy.actor?.statuses?.has("incapacitated")) return [];
      const ranges = weaponRanges(enemy.actor?.items ?? [], canvas.scene.grid.units);
      return ranges.length ? [{ token: enemy, ranges }] : [];
    });
  }

  preview(token: Token, destination: MovementWaypoint): Threat[] {
    if (!this.enabled) return [];
    return this.#withSight(token, token.document._source, canSee => this.#enemies(token).flatMap(enemy => {
      if (!canSee(enemy.token)) return [];
      const threat = this.#threat(token, destination, enemy);
      return threat ? [threat] : [];
    }));
  }

  firstDiscovery(token: Token, path: readonly MovementWaypoint[]): ThreatDiscovery | null {
    if (!this.enabled || path.length < 2) return null;
    const enemies = this.#enemies(token);
    const unseen = this.#withSight(token, path[0]!, canSee => enemies.filter(enemy => !canSee(enemy.token)), true);
    if (!unseen.length) return null;
    const destination = path.at(-1)!;
    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1]!, to = path[i]!;
      // Inspect intermediate positions too, including long straight and vertical segments.
      const steps = Math.max(1, Math.ceil(Math.max(Math.hypot(to.x - from.x, to.y - from.y) / canvas.grid.size,
        Math.abs(to.elevation - from.elevation) / canvas.grid.distance) * 4));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const point = step === steps ? to : { ...from, x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t, elevation: from.elevation + (to.elevation - from.elevation) * t,
          explicit: true, snapped: false, checkpoint: false };
        const detected = this.#withSight(token, point, canSee => unseen.some(enemy => canSee(enemy.token)
          && (this.#threat(token, destination, enemy) || this.#threat(token, point, enemy))), true);
        if (detected) return {
          path: [...path.slice(0, i), point],
          remainder: [point, ...(step === steps ? path.slice(i + 1) : path.slice(i))],
        };
      }
    }
    return null;
  }

  #threat(token: Token, destination: MovementWaypoint, enemy: { token: Token; ranges: WeaponRange[] }): Threat | null {
    const from = enemy.token.document.getMovementOrigin(enemy.token.document._source);
    const to = token.document.getMovementOrigin(destination);
    const distance = canvas.grid.measurePath([from, to]).distance;
    const band = rangeBand(enemy.ranges, distance);
    if (!band || enemy.token.checkCollision(to, { origin: from, type: "sight", mode: "any" })) return null;
    const source = enemy.token.document._source;
    return { tokenId: enemy.token.id, from, to, band,
      bounds: { x: source.x, y: source.y, width: source.width * canvas.grid.size, height: source.height * canvas.grid.size } };
  }

  #withSight<T>(token: Token, position: MovementWaypoint, test: (canSee: (enemy: Token) => boolean) => T, centerOnly = false): T {
    let source: VisionSource | null = null;
    try {
      if (canvas.visibility.tokenVision) {
        if (token.hasSight === false || !token._getVisionSourceData || !token.document.getVisionOrigin || !CONFIG.Canvas.visionSourceClass) {
          return test(() => false);
        }
        // A private source never joins canvas.effects, changes fog, or exposes unseen tokens during preview.
        source = new CONFIG.Canvas.visionSourceClass({ object: token, sourceId: `${MODULE_ID}.threat-sight` });
        Object.assign(source.blinded ?? {}, token._getVisionBlindedStates?.());
        source.initialize?.({ ...token._getVisionSourceData(), ...token.document.getVisionOrigin(position),
          level: position.level, preview: true });
      }
      return test(enemy => {
        if (enemy.document.hidden) return false;
        if (!canvas.visibility.tokenVision) {
          if (token.actor?.statuses?.has("blinded") || enemy.actor?.statuses?.has("invisible")) return false;
          const origin = token.document.getMovementOrigin(position);
          return !token.checkCollision(enemy.document.getMovementOrigin(enemy.document._source),
            { origin, type: "sight", mode: "any" });
        }
        // In v14 active means attached to the canvas. This private source is deliberately unattached.
        if (!source || source.isBlinded || source.suppressed || source.data?.disabled) return false;
        // Interrupt only once the enemy's center is visible, rather than on a barely exposed edge.
        const points = (!centerOnly && enemy.document.getVisibilityTestPoints?.(enemy.document._source))
          || [enemy.document.getMovementOrigin(enemy.document._source)];
        const config = canvas.visibility._createVisibilityTestConfig(points, { tolerance: 0, object: enemy });
        return ["basicSight", "lightPerception"].some(id => {
          const mode = token.document.detectionModes[id];
          return mode && CONFIG.Canvas.detectionModes[id]?.testVisibility(source!, mode, config);
        });
      });
    } finally { source?.destroy?.(); }
  }
}
