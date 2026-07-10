export interface GridOffset {
  i: number;
  j: number;
}

export interface ReachabilityAdapter {
  getNeighbors(offset: GridOffset): GridOffset[];
  getPathCost(path: readonly GridOffset[]): number;
  canOccupy(offset: GridOffset): boolean;
  canTraverse(from: GridOffset, to: GridOffset): boolean;
}

export interface ReachabilityResult {
  costs: Map<string, number>;
  paths: Map<string, GridOffset[]>;
}

interface QueueEntry {
  offset: GridOffset;
  cost: number;
  geometricLength: number;
  bends: number;
  path: GridOffset[];
}

function compareEntries(first: QueueEntry, second: QueueEntry): number {
  return (
    first.cost - second.cost ||
    first.geometricLength - second.geometricLength ||
    first.bends - second.bends
  );
}

class MinQueue {
  readonly #entries: QueueEntry[] = [];

  get size(): number {
    return this.#entries.length;
  }

  push(entry: QueueEntry): void {
    this.#entries.push(entry);
    let index = this.#entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentEntry = this.#entries[parent];
      if (!parentEntry || compareEntries(parentEntry, entry) <= 0) break;
      this.#entries[index] = parentEntry;
      index = parent;
    }
    this.#entries[index] = entry;
  }

  pop(): QueueEntry | undefined {
    const first = this.#entries[0];
    const last = this.#entries.pop();
    if (!first || !last || this.#entries.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let child = left;
      if (
        right < this.#entries.length &&
        this.#entries[right] !== undefined &&
        this.#entries[left] !== undefined &&
        compareEntries(this.#entries[right], this.#entries[left]) < 0
      ) {
        child = right;
      }
      const childEntry = this.#entries[child];
      if (!childEntry || compareEntries(childEntry, last) >= 0) break;
      this.#entries[index] = childEntry;
      index = child;
    }
    this.#entries[index] = last;
    return first;
  }
}

export function offsetKey(offset: GridOffset): string {
  return `${offset.i},${offset.j}`;
}

export function parseOffsetKey(key: string): GridOffset {
  const [i, j] = key.split(",").map(Number);
  if (i === undefined || j === undefined || !Number.isFinite(i) || !Number.isFinite(j)) {
    throw new Error(`Invalid grid offset key: ${key}`);
  }
  return { i, j };
}

export function findReachability(
  start: GridOffset,
  maximumCost: number,
  adapter: ReachabilityAdapter,
): ReachabilityResult {
  const costs = new Map<string, number>();
  const geometricLengths = new Map<string, number>();
  const bends = new Map<string, number>();
  const paths = new Map<string, GridOffset[]>();
  if (maximumCost < 0 || !adapter.canOccupy(start)) return { costs, paths };

  const queue = new MinQueue();
  costs.set(offsetKey(start), 0);
  geometricLengths.set(offsetKey(start), 0);
  bends.set(offsetKey(start), 0);
  paths.set(offsetKey(start), [start]);
  queue.push({ offset: start, cost: 0, geometricLength: 0, bends: 0, path: [start] });

  while (queue.size > 0) {
    const current = queue.pop();
    if (!current) break;
    const currentKey = offsetKey(current.offset);
    if (current.cost > (costs.get(currentKey) ?? Infinity)) continue;
    if (
      Math.abs(current.cost - (costs.get(currentKey) ?? Infinity)) <= 0.01 &&
      (current.geometricLength > (geometricLengths.get(currentKey) ?? Infinity) + 0.001 ||
        (Math.abs(current.geometricLength - (geometricLengths.get(currentKey) ?? Infinity)) <= 0.001 &&
          current.bends > (bends.get(currentKey) ?? Infinity)))
    ) {
      continue;
    }

    for (const neighbor of adapter.getNeighbors(current.offset)) {
      if (!adapter.canOccupy(neighbor) || !adapter.canTraverse(current.offset, neighbor)) continue;
      const path = [...current.path, neighbor];
      const measuredCost = adapter.getPathCost(path);
      if (!Number.isFinite(measuredCost) || measuredCost <= current.cost) continue;
      const cost = Math.round(measuredCost * 100) / 100;
      if (cost > maximumCost + 0.01) continue;
      const key = offsetKey(neighbor);
      const geometricLength = current.geometricLength + Math.hypot(
        neighbor.i - current.offset.i,
        neighbor.j - current.offset.j,
      );
      const previous = current.path.at(-2);
      const bendCount = current.bends + (previous &&
        (current.offset.i - previous.i !== neighbor.i - current.offset.i ||
          current.offset.j - previous.j !== neighbor.j - current.offset.j)
        ? 1
        : 0);
      const existingCost = costs.get(key) ?? Infinity;
      const existingLength = geometricLengths.get(key) ?? Infinity;
      const existingBends = bends.get(key) ?? Infinity;
      if (cost > existingCost + 0.01) continue;
      if (
        Math.abs(cost - existingCost) <= 0.01 &&
        (geometricLength > existingLength + 0.001 ||
          (Math.abs(geometricLength - existingLength) <= 0.001 && bendCount >= existingBends))
      ) {
        continue;
      }
      costs.set(key, cost);
      geometricLengths.set(key, geometricLength);
      bends.set(key, bendCount);
      paths.set(key, path);
      queue.push({ offset: neighbor, cost, geometricLength, bends: bendCount, path });
    }
  }

  return { costs, paths };
}

export function findReachableCosts(
  start: GridOffset,
  maximumCost: number,
  adapter: ReachabilityAdapter,
): Map<string, number> {
  return findReachability(start, maximumCost, adapter).costs;
}

export function cellsWithin(costs: ReadonlyMap<string, number>, distance: number): Set<string> {
  return new Set([...costs].filter(([, cost]) => cost <= distance + 0.01).map(([key]) => key));
}

export function expandToFootprint(
  anchors: ReadonlySet<string>,
  width: number,
  height: number,
): Set<string> {
  const cells = new Set<string>();
  for (const key of anchors) {
    const anchor = parseOffsetKey(key);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        cells.add(offsetKey({ i: anchor.i + row, j: anchor.j + column }));
      }
    }
  }
  return cells;
}
