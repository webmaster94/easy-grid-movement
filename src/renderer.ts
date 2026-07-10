import { STYLES } from "./constants";
import { parseOffsetKey, type GridOffset } from "./grid";

type RegionStyle = (typeof STYLES)["walk"] | (typeof STYLES)["dash"];

export interface MovementRendererHandlers {
  onHover(key: string): void;
  onLeave(): void;
  onSelect(key: string): void;
}

export interface MovementPreview {
  path: readonly Point[];
  cost: number;
  destination: GridOffset;
  dash: boolean;
}

export class MovementRenderer {
  #container: PIXI.Container | null = null;
  #previewGraphics: PIXI.Graphics | null = null;
  #distanceLabel: PIXI.Text | null = null;
  #previousGridInteraction: boolean | null = null;

  clear(): void {
    this.#container?.destroy({ children: true });
    if (this.#previousGridInteraction !== null && canvas.interface?.grid) {
      canvas.interface.grid.interactiveChildren = this.#previousGridInteraction;
    }
    this.#container = null;
    this.#previewGraphics = null;
    this.#distanceLabel = null;
    this.#previousGridInteraction = null;
  }

  draw(
    walkCells: ReadonlySet<string>,
    dashCells: ReadonlySet<string>,
    handlers: MovementRendererHandlers,
  ): void {
    if (!canvas.interface?.grid || !canvas.grid) return;
    this.clear();
    this.#previousGridInteraction = canvas.interface.grid.interactiveChildren;
    canvas.interface.grid.interactiveChildren = true;
    this.#container = new PIXI.Container();
    this.#container.sortableChildren = true;
    canvas.interface.grid.addChild(this.#container);

    const ranges = new PIXI.Graphics();
    ranges.eventMode = "none";
    ranges.zIndex = 0;
    this.#container.addChild(ranges);
    this.#drawRegion(ranges, dashCells, STYLES.dash);
    this.#drawRegion(ranges, walkCells, STYLES.walk);

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

    for (const key of dashCells) {
      const offset = parseOffsetKey(key);
      const point = canvas.grid.getTopLeftPoint(offset);
      const target = new PIXI.Graphics();
      target.beginFill(0xffffff, 0.001);
      target.drawRect(point.x, point.y, canvas.grid.size, canvas.grid.size);
      target.endFill();
      target.eventMode = "static";
      target.cursor = "pointer";
      target.zIndex = 20;
      target.on("pointerover", () => handlers.onHover(key));
      target.on("pointerout", () => handlers.onLeave());
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
    const color = preview.dash ? STYLES.dash.borderColor : STYLES.walk.borderColor;
    const graphics = this.#previewGraphics;
    graphics.clear();
    graphics.lineStyle(7, 0x000000, 0.8, 0.5);
    this.#drawPath(graphics, preview.path);
    graphics.lineStyle(4, color, 1, 0.5);
    this.#drawPath(graphics, preview.path);

    const destinationPoint = canvas.grid.getTopLeftPoint(preview.destination);
    graphics.lineStyle(5, 0xffffff, 1, 0.5);
    graphics.drawRect(destinationPoint.x, destinationPoint.y, canvas.grid.size, canvas.grid.size);

    const finalPoint = preview.path.at(-1);
    if (!finalPoint) return;
    this.#distanceLabel.text = `${this.#formatDistance(preview.cost)} ${canvas.scene.grid.units}`.trim();
    this.#distanceLabel.position.set(finalPoint.x, finalPoint.y - canvas.grid.size * 0.15);
    this.#distanceLabel.visible = true;
  }

  clearPreview(): void {
    this.#previewGraphics?.clear();
    if (this.#distanceLabel) this.#distanceLabel.visible = false;
  }

  #drawPath(graphics: PIXI.Graphics, path: readonly Point[]): void {
    const first = path[0];
    if (!first) return;
    graphics.moveTo(first.x, first.y);
    for (const point of path.slice(1)) graphics.lineTo(point.x, point.y);
  }

  #formatDistance(distance: number): string {
    return Number.isInteger(distance) ? String(distance) : distance.toFixed(1);
  }

  #drawRegion(graphics: PIXI.Graphics, cells: ReadonlySet<string>, style: RegionStyle): void {
    const size = canvas.grid.size;
    graphics.beginFill(style.fillColor, style.fillAlpha);
    graphics.lineStyle(0);
    for (const key of cells) {
      const point = canvas.grid.getTopLeftPoint(parseOffsetKey(key));
      graphics.drawRect(point.x, point.y, size, size);
    }
    graphics.endFill();

    graphics.lineStyle(style.borderWidth, style.borderColor, style.borderAlpha, 0.5);
    for (const key of cells) {
      const { i, j } = parseOffsetKey(key);
      const point = canvas.grid.getTopLeftPoint({ i, j });
      if (!cells.has(`${i - 1},${j}`)) graphics.moveTo(point.x, point.y).lineTo(point.x + size, point.y);
      if (!cells.has(`${i + 1},${j}`)) {
        graphics.moveTo(point.x, point.y + size).lineTo(point.x + size, point.y + size);
      }
      if (!cells.has(`${i},${j - 1}`)) graphics.moveTo(point.x, point.y).lineTo(point.x, point.y + size);
      if (!cells.has(`${i},${j + 1}`)) {
        graphics.moveTo(point.x + size, point.y).lineTo(point.x + size, point.y + size);
      }
    }
  }
}
