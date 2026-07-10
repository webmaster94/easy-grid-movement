import { MODULE_ID, STYLES } from "./constants";
import { parseOffsetKey, type GridOffset } from "./grid";
import type { MovementBand } from "./movement-band";

type RegionStyle = (typeof STYLES)[MovementBand];
type HighlightZone = "walk" | "dash";

interface GridEdge {
  from: Point;
  to: Point;
  zones: Set<HighlightZone>;
}

const HIGHLIGHT_LAYER = `${MODULE_ID}.movement-ranges`;

export interface MovementRendererHandlers {
  onHover(key: string): void;
  onLeave(): void;
  onElevation(key: string, wheelDelta: number, precise: boolean): void;
  onSelect(key: string): void;
}

export interface MovementPreview {
  path: readonly Point[];
  segmentBands: readonly MovementBand[];
  difficultSegments: readonly boolean[];
  cost: number;
  destination: GridOffset;
  footprint: { width: number; height: number };
  elevation: number;
  elevationDelta: number;
  destinationBand: MovementBand;
}

export class MovementRenderer {
  #container: PIXI.Container | null = null;
  #previewGraphics: PIXI.Graphics | null = null;
  #distanceLabel: PIXI.Text | null = null;
  #hoveredKey: string | null = null;
  #previousGridInteraction: boolean | null = null;
  #wheelListener: ((event: WheelEvent) => void) | null = null;

  clear(): void {
    if (this.#wheelListener) window.removeEventListener("wheel", this.#wheelListener, true);
    if (canvas.interface?.grid) canvas.interface.grid.destroyHighlightLayer(HIGHLIGHT_LAYER);
    this.#container?.destroy({ children: true });
    if (this.#previousGridInteraction !== null && canvas.interface?.grid) {
      canvas.interface.grid.interactiveChildren = this.#previousGridInteraction;
    }
    this.#container = null;
    this.#previewGraphics = null;
    this.#distanceLabel = null;
    this.#hoveredKey = null;
    this.#previousGridInteraction = null;
    this.#wheelListener = null;
  }

  draw(
    walkCells: ReadonlySet<string>,
    dashCells: ReadonlySet<string>,
    overCells: ReadonlySet<string>,
    difficultCells: ReadonlySet<string>,
    handlers: MovementRendererHandlers,
  ): void {
    if (!canvas.interface?.grid || !canvas.grid) return;
    this.clear();
    this.#previousGridInteraction = canvas.interface.grid.interactiveChildren;
    canvas.interface.grid.interactiveChildren = true;
    this.#container = new PIXI.Container();
    this.#container.sortableChildren = true;
    canvas.interface.grid.addChild(this.#container);

    const ranges = canvas.interface.grid.addHighlightLayer(HIGHLIGHT_LAYER);
    ranges.eventMode = "none";
    this.#drawMovementGrid(ranges, walkCells, dashCells);
    this.#drawDifficultTerrain(ranges, difficultCells);

    this.#wheelListener = (event) => {
      const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
      if (!hoveredElement || hoveredElement.id !== "board") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const delta = event.deltaY || event.deltaX || 0;
      if (this.#hoveredKey && delta !== 0) {
        handlers.onElevation(this.#hoveredKey, delta, event.shiftKey);
      }
    };
    window.addEventListener("wheel", this.#wheelListener, { capture: true, passive: false });

    this.#previewGraphics = new PIXI.Graphics();
    this.#previewGraphics.eventMode = "none";
    this.#previewGraphics.zIndex = 10;
    this.#container.addChild(this.#previewGraphics);

    this.#distanceLabel = new PIXI.Text("", {
      align: "center",
      fill: 0xffffff,
      fontFamily: "Signika, sans-serif",
      fontSize: 24,
      fontWeight: "bold",
      stroke: 0x000000,
      strokeThickness: 5,
    });
    this.#distanceLabel.anchor.set(0.5, 1);
    this.#distanceLabel.eventMode = "none";
    this.#distanceLabel.visible = false;
    this.#distanceLabel.zIndex = 11;
    this.#container.addChild(this.#distanceLabel);

    for (const key of overCells) {
      const offset = parseOffsetKey(key);
      const point = canvas.grid.getTopLeftPoint(offset);
      const target = new PIXI.Graphics();
      target.beginFill(0xffffff, 0.001);
      target.drawRect(point.x, point.y, canvas.grid.size, canvas.grid.size);
      target.endFill();
      target.eventMode = "static";
      target.cursor = "pointer";
      target.zIndex = 20;
      target.on("pointerover", () => {
        this.#hoveredKey = key;
        handlers.onHover(key);
      });
      target.on("pointerout", () => {
        if (this.#hoveredKey === key) this.#hoveredKey = null;
        handlers.onLeave();
      });
      target.on("pointertap", (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        handlers.onSelect(key);
      });
      this.#container.addChild(target);
    }
  }

  showPreview(preview: MovementPreview): void {
    if (!this.#previewGraphics || !this.#distanceLabel || preview.path.length === 0) return;
    const graphics = this.#previewGraphics;
    graphics.clear();
    graphics.lineStyle(7, 0x000000, 0.8, 0.5);
    this.#drawPath(graphics, preview.path, preview.difficultSegments);
    for (let index = 1; index < preview.path.length; index += 1) {
      const from = preview.path[index - 1];
      const to = preview.path[index];
      if (!from || !to) continue;
      const band = preview.segmentBands[index - 1] ?? "over";
      graphics.lineStyle(4, STYLES[band].borderColor, 1, 0.5);
      this.#drawSegment(graphics, from, to, preview.difficultSegments[index - 1] === true);
    }

    const destinationPoint = canvas.grid.getTopLeftPoint(preview.destination);
    graphics.lineStyle(5, STYLES[preview.destinationBand].borderColor, 1, 0.5);
    graphics.drawRect(
      destinationPoint.x,
      destinationPoint.y,
      canvas.grid.size * preview.footprint.width,
      canvas.grid.size * preview.footprint.height,
    );

    const finalPoint = preview.path.at(-1);
    if (!finalPoint) return;
    const units = canvas.scene.grid.units;
    const distanceLabel = `${this.#formatDistance(preview.cost)} ${units}`.trim();
    const elevationLabel = preview.elevationDelta === 0
      ? ""
      : `\n↕ ${this.#formatSigned(preview.elevationDelta)} ${units} (${this.#formatDistance(preview.elevation)} ${units})`;
    this.#distanceLabel.text = `${distanceLabel}${elevationLabel}`;
    this.#distanceLabel.position.set(finalPoint.x, finalPoint.y - canvas.grid.size * 0.15);
    this.#distanceLabel.visible = true;
  }

  clearPreview(): void {
    this.#previewGraphics?.clear();
    if (this.#distanceLabel) this.#distanceLabel.visible = false;
  }

  #drawPath(
    graphics: PIXI.Graphics,
    path: readonly Point[],
    difficultSegments: readonly boolean[],
  ): void {
    const first = path[0];
    if (!first) return;
    for (let index = 1; index < path.length; index += 1) {
      const from = path[index - 1];
      const to = path[index];
      if (!from || !to) continue;
      this.#drawSegment(graphics, from, to, difficultSegments[index - 1] === true);
    }
  }

  #drawSegment(graphics: PIXI.Graphics, from: Point, to: Point, difficult: boolean): void {
    graphics.moveTo(from.x, from.y);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (!difficult || length < canvas.grid.size * 0.3) {
      graphics.lineTo(to.x, to.y);
      return;
    }

    const steps = Math.max(2, Math.ceil(length / (canvas.grid.size * 0.24)));
    const perpendicularX = -dy / length;
    const perpendicularY = dx / length;
    const amplitude = canvas.grid.size * 0.075;
    for (let step = 1; step < steps; step += 1) {
      const progress = step / steps;
      const direction = step % 2 === 0 ? -1 : 1;
      graphics.lineTo(
        from.x + dx * progress + perpendicularX * amplitude * direction,
        from.y + dy * progress + perpendicularY * amplitude * direction,
      );
    }
    graphics.lineTo(to.x, to.y);
  }

  #formatDistance(distance: number): string {
    return Number.isInteger(distance) ? String(distance) : distance.toFixed(1);
  }

  #formatSigned(distance: number): string {
    const formatted = this.#formatDistance(distance);
    return distance > 0 ? `+${formatted}` : formatted;
  }

  #drawMovementGrid(
    graphics: PIXI.Graphics,
    walkCells: ReadonlySet<string>,
    dashCells: ReadonlySet<string>,
  ): void {
    const edges = new Map<string, GridEdge>();
    for (const key of dashCells) {
      const zone: HighlightZone = walkCells.has(key) ? "walk" : "dash";
      const vertices = canvas.grid.getVertices(parseOffsetKey(key));
      for (let index = 0; index < vertices.length; index += 1) {
        const from = vertices[index];
        const to = vertices[(index + 1) % vertices.length];
        if (!from || !to) continue;
        const edgeKey = this.#edgeKey(from, to);
        const edge = edges.get(edgeKey) ?? { from, to, zones: new Set<HighlightZone>() };
        edge.zones.add(zone);
        edges.set(edgeKey, edge);
      }
    }

    for (const edge of edges.values()) {
      const zone: HighlightZone = edge.zones.has("dash") ? "dash" : "walk";
      this.#drawDottedEdge(graphics, edge.from, edge.to, STYLES[zone]);
    }

    for (const edge of edges.values()) {
      if (edge.zones.size < 2) continue;
      const style = STYLES.dash;
      graphics.lineStyle(style.borderWidth, style.borderColor, style.borderAlpha, 0.5);
      graphics.moveTo(edge.from.x, edge.from.y).lineTo(edge.to.x, edge.to.y);
    }
  }

  #drawDottedEdge(graphics: PIXI.Graphics, from: Point, to: Point, style: RegionStyle): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) return;
    const spacing = Math.max(style.borderWidth * 3.5, canvas.grid.size * 0.12);
    const radius = style.borderWidth * 0.65;
    graphics.beginFill(style.borderColor, style.borderAlpha);
    for (let distance = spacing / 2; distance < length; distance += spacing) {
      const progress = distance / length;
      graphics.drawCircle(from.x + dx * progress, from.y + dy * progress, radius);
    }
    graphics.endFill();
  }

  #edgeKey(first: Point, second: Point): string {
    const firstKey = `${Math.round(first.x * 1000)},${Math.round(first.y * 1000)}`;
    const secondKey = `${Math.round(second.x * 1000)},${Math.round(second.y * 1000)}`;
    return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
  }

  #drawDifficultTerrain(graphics: PIXI.Graphics, cells: ReadonlySet<string>): void {
    const size = canvas.grid.size;
    const spacing = size / 3;
    graphics.lineStyle(
      STYLES.difficult.width,
      STYLES.difficult.color,
      STYLES.difficult.alpha,
      0.5,
    );
    for (const key of cells) {
      const point = canvas.grid.getTopLeftPoint(parseOffsetKey(key));
      for (let row = spacing * 0.65; row < size; row += spacing) {
        const peak = Math.max(0, row - spacing * 0.45);
        graphics
          .moveTo(point.x, point.y + row)
          .lineTo(point.x + size / 2, point.y + peak)
          .lineTo(point.x + size, point.y + row);
      }
    }
  }
}
