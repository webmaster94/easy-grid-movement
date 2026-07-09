interface Point {
  x: number;
  y: number;
  elevation?: number;
}

interface TokenDocument {
  id: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  inCombat: boolean;
  getCenterPoint(data?: Partial<Point>): Point;
}

interface Token {
  id: string;
  name: string;
  document: TokenDocument;
  actor?: {
    system?: {
      attributes?: {
        movement?: {
          walk?: number | string | null;
        };
      };
    };
  } | null;
  checkCollision(
    destination: Point,
    options?: { origin?: Point; type?: "move" | "sight" | "light"; mode?: "any" | "all" | "closest" },
  ): boolean | unknown[] | object | null;
}

interface TokenUpdate {
  x?: number;
  y?: number;
}

interface GridOffset {
  i: number;
  j: number;
}

interface HooksApi {
  once(hook: "init", callback: () => unknown): number;
  on(hook: "updateCombat", callback: (combat: unknown, changes: Record<string, unknown>) => unknown): number;
  on(hook: "deleteCombat", callback: () => unknown): number;
  on(hook: "preUpdateToken", callback: (document: TokenDocument, changes: TokenUpdate) => unknown): number;
  on(hook: "updateToken", callback: (document: TokenDocument, changes: TokenUpdate) => unknown): number;
  on(hook: "controlToken", callback: (token: Token, controlled: boolean) => unknown): number;
  on(hook: "canvasReady", callback: () => unknown): number;
  on(hook: "canvasTearDown", callback: () => unknown): number;
}

declare const Hooks: HooksApi;

declare const game: {
  combat?: { started?: boolean } | null;
  i18n: { localize(key: string): string };
  settings: {
    get(moduleId: string, key: string): unknown;
    register(moduleId: string, key: string, data: Record<string, unknown>): void;
  };
  keybindings: {
    register(moduleId: string, key: string, data: Record<string, unknown>): void;
  };
};

declare const canvas: {
  grid: {
    isSquare: boolean;
    size: number;
    distance: number;
    getOffset(point: Point): GridOffset;
    getTopLeftPoint(offset: GridOffset): Point;
    getAdjacentOffsets(offset: GridOffset): GridOffset[];
    measurePath(points: Point[]): { distance: number };
  };
  dimensions: {
    sceneX: number;
    sceneY: number;
    sceneWidth: number;
    sceneHeight: number;
  };
  tokens: {
    controlled: Token[];
    get(id: string): Token | undefined;
  };
  interface: {
    grid: {
      addChild(child: PIXI.Container): void;
    };
  };
};

declare const ui: {
  notifications: {
    info(message: string): void;
    warn(message: string): void;
  };
};

declare namespace PIXI {
  class Container {
    addChild(child: Graphics): void;
    destroy(options?: { children?: boolean }): void;
  }

  class Graphics {
    beginFill(color?: number, alpha?: number): this;
    endFill(): this;
    lineStyle(width?: number, color?: number, alpha?: number, alignment?: number): this;
    drawRect(x: number, y: number, width: number, height: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
  }
}
