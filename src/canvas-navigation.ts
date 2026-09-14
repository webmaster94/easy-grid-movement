/** Reserve a short right-click for undo while retaining right-drag canvas navigation. */
export class CanvasNavigation {
  #gesture: { pointer: number; x: number; y: number; lastX: number; lastY: number; started: number; dragging: boolean } | null = null;
  #cancel: (() => void) | null = null;
  #navigate: (() => void) | null = null;
  #attached = false;

  activate(cancel: () => void, navigate: () => void): void {
    this.#cancel = cancel; this.#navigate = navigate;
    if (this.#attached) return;
    this.#attached = true;
    window.addEventListener("pointerdown", this.#down, true);
    window.addEventListener("pointermove", this.#move, true);
    window.addEventListener("pointerup", this.#up, true);
    window.addEventListener("pointercancel", this.#reset, true);
    window.addEventListener("blur", this.#reset, true);
    window.addEventListener("contextmenu", this.#menu, true);
  }

  clear(): void {
    if (!this.#attached) return;
    window.removeEventListener("pointerdown", this.#down, true);
    window.removeEventListener("pointermove", this.#move, true);
    window.removeEventListener("pointerup", this.#up, true);
    window.removeEventListener("pointercancel", this.#reset, true);
    window.removeEventListener("blur", this.#reset, true);
    window.removeEventListener("contextmenu", this.#menu, true);
    this.#attached = false; this.#gesture = null; this.#cancel = null; this.#navigate = null;
  }

  #board(event: MouseEvent): boolean { return document.elementFromPoint(event.clientX, event.clientY)?.id === "board"; }
  #consume(event: Event): void { event.preventDefault(); event.stopImmediatePropagation(); }
  #reset = (): void => { this.#gesture = null; };
  #menu = (event: MouseEvent): void => { if (this.#gesture || this.#board(event)) this.#consume(event); };
  #down = (event: PointerEvent): void => {
    if (event.button !== 2 || !this.#board(event)) return;
    this.#consume(event);
    this.#gesture = { pointer: event.pointerId, x: event.clientX, y: event.clientY,
      lastX: event.clientX, lastY: event.clientY, started: event.timeStamp, dragging: false };
  };
  #move = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (!(event.buttons & 2)) { this.#reset(); return; }
    this.#consume(event);
    if (!gesture.dragging && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 6) {
      gesture.dragging = true; this.#navigate?.();
    }
    if (!gesture.dragging) return;
    const scale = canvas.stage.scale.x;
    const speed = CONFIG.Canvas.dragSpeedModifier ?? 1;
    canvas.pan({ x: canvas.stage.pivot.x - (event.clientX - gesture.lastX) * speed / scale,
      y: canvas.stage.pivot.y - (event.clientY - gesture.lastY) * speed / scale, scale });
    gesture.lastX = event.clientX; gesture.lastY = event.clientY;
  };
  #up = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (!gesture || gesture.pointer !== event.pointerId || event.button !== 2) return;
    this.#consume(event); this.#reset();
    if (!gesture.dragging && event.timeStamp - gesture.started < 350
      && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6 && this.#board(event)) this.#cancel?.();
  };
}
