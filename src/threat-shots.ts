export interface CameraView { x: number; y: number; scale: number }
export interface ThreatShot { ids: string[]; view: CameraView }
export interface ShotTarget { id: string; x: number; y: number; width: number; height: number }

/** Merge the closest groups while their combined bounds fit the configured span. */
export function groupThreatShots(targets: readonly ShotTarget[], maxSpan: number, padding: number,
  viewport: { width: number; height: number }): ThreatShot[] {
  const bounds = (group: readonly ShotTarget[]) => {
    const left = Math.min(...group.map(t => t.x - t.width / 2));
    const right = Math.max(...group.map(t => t.x + t.width / 2));
    const top = Math.min(...group.map(t => t.y - t.height / 2));
    const bottom = Math.max(...group.map(t => t.y + t.height / 2));
    return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
  };
  const groups = [...new Map(targets.map(t => [t.id, t])).values()].map(t => [t]);
  while (groups.length > 1) {
    let pair: [number, number] | null = null, best = Infinity;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const b = bounds([...groups[i]!, ...groups[j]!]);
      const distance = Math.hypot(b.width, b.height);
      if (Math.max(b.width, b.height) <= maxSpan && distance < best) { best = distance; pair = [i, j]; }
    }
    if (!pair) break;
    groups[pair[0]]!.push(...groups[pair[1]]!); groups.splice(pair[1], 1);
  }
  return groups.map(group => {
    const b = bounds(group);
    const portraitScale = 220 / Math.max(...group.map(t => Math.max(t.width, t.height)));
    return { ids: group.map(t => t.id), view: { x: b.x, y: b.y,
      scale: Math.min(2, portraitScale, viewport.width / (b.width + 2 * padding), viewport.height / (b.height + 2 * padding)) } };
  });
}
