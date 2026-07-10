interface Point {
  x: number;
  y: number;
  elevation?: number;
}

interface MovementWaypoint extends Point {
  elevation: number;
  width: number;
  height: number;
  depth: number;
  shape: number;
  level: string;
  action?: string;
  checkpoint?: boolean;
  explicit?: boolean;
  snapped?: boolean;
}

interface MovementMeasurement {
  cost?: number;
  distance: number;
  spaces?: number;
}

interface TokenDocument {
  id: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  level: string;
  inCombat: boolean;
  movementAction: string;
  _movementHistory?: MovementWaypoint[];
  _source: MovementWaypoint;
  getCenterPoint(data?: Partial<Point>): Point;
  getMovementOrigin(data?: Partial<MovementWaypoint>): Point;
  getOccupiedGridSpaceOffsets(data?: Partial<MovementWaypoint>): GridOffset[];
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
  constrainMovementPath(
    waypoints: MovementWaypoint[],
    options: { preview?: boolean; ignoreCost?: boolean; ignoreTokens?: boolean },
  ): [MovementWaypoint[], boolean];
  createTerrainMovementPath(
    waypoints: MovementWaypoint[],
    options?: { preview?: boolean },
  ): MovementWaypoint[];
  findMovementPath(
    waypoints: MovementWaypoint[],
    options?: { preview?: boolean; constrainOptions?: Record<string, unknown> },
  ): { result: MovementWaypoint[]; promise: Promise<MovementWaypoint[]>; cancel(): void };
  measureMovementPath(
    waypoints: MovementWaypoint[],
    options?: { preview?: boolean },
  ): MovementMeasurement;
}

interface TokenUpdate {
  x?: number;
  y?: number;
  _movementHistory?: MovementWaypoint[];
}

interface GridOffset {
  i: number;
  j: number;
  k?: number;
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
    rect: { contains(x: number, y: number): boolean };
  };
  tokens: {
    controlled: Token[];
    placeables: Token[];
    get(id: string): Token | undefined;
  };
  scene: {
    grid: { units: string };
    updateEmbeddedDocuments(
      documentName: "Token",
      updates: Array<{ _id: string }>,
      options: Record<string, unknown>,
    ): Promise<unknown[]>;
  };
  interface: {
    grid: {
      interactiveChildren: boolean;
      addChild(child: PIXI.Container): void;
    };
  };
};

declare const ui: {
  notifications: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
};

declare namespace PIXI {
  class Container {
    interactiveChildren: boolean;
    sortableChildren: boolean;
    zIndex: number;
    eventMode: string;
    addChild<T extends Container | Graphics | Text>(child: T): T;
    destroy(options?: { children?: boolean }): void;
  }

  class Graphics {
    cursor: string;
    eventMode: string;
    zIndex: number;
    beginFill(color?: number, alpha?: number): this;
    clear(): this;
    endFill(): this;
    lineStyle(width?: number, color?: number, alpha?: number, alignment?: number): this;
    drawCircle(x: number, y: number, radius: number): this;
    drawRect(x: number, y: number, width: number, height: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    on(event: "pointerover" | "pointerout", callback: () => void): this;
    on(event: "pointertap", callback: (event: FederatedPointerEvent) => void): this;
  }

  interface FederatedPointerEvent {
    button: number;
    stopPropagation(): void;
  }

  class Text {
    constructor(text: string, style?: Record<string, unknown>);
    anchor: { set(x: number, y?: number): void };
    eventMode: string;
    position: { set(x: number, y: number): void };
    text: string;
    visible: boolean;
    zIndex: number;
  }
}
