import { CINEMATIC_GROUP_DISTANCE_SETTING, MODULE_ID } from "./constants";
import { groupThreatShots, type CameraView, type ThreatShot } from "./threat-shots";
export type { CameraView } from "./threat-shots";
export interface CinematicView {
  scene(): unknown;
  camera(): CameraView;
  shots(ids: readonly string[]): ThreatShot[];
  pan(view: CameraView, duration: number): Promise<unknown>;
  stopPan(): void;
  banner(touring: boolean): void;
  hideBanner(): void;
  spotlight(id: string): () => void;
  highlight(ids: readonly string[]): void;
  clearHighlights(): void;
  reducedMotion(): boolean;
}

export class ThreatCinematic {
  readonly #view: CinematicView;
  #abort: AbortController | null = null;
  #restoreCamera = true;
  constructor(view: CinematicView = new FoundryCinematicView()) { this.#view = view; }
  get playing(): boolean { return this.#abort !== null; }
  highlight(ids: readonly string[]): void { this.#view.highlight(ids); }
  cancel(): void { this.#abort?.abort(); }
  releaseCamera(): void { this.#restoreCamera = false; this.cancel(); }
  clear(): void { this.cancel(); this.#view.clearHighlights(); }

  async play(ids: readonly string[], current: () => boolean): Promise<void> {
    if (this.playing || !ids.length || !current()) return;
    const view = this.#view, original = view.camera(), scene = view.scene();
    const abort = this.#abort = new AbortController();
    this.#restoreCamera = true;
    const valid = (): boolean => !abort.signal.aborted && scene === view.scene() && current();
    const duration = view.reducedMotion() ? 0 : 650;
    const stop = (): void => view.stopPan();
    abort.signal.addEventListener("abort", stop, { once: true });
    let release = (): void => {};
    const wait = (ms: number): Promise<void> => new Promise(resolve => {
      const done = (): void => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); };
      const timer = globalThis.setTimeout(done, ms);
      abort.signal.addEventListener("abort", done, { once: true });
      if (abort.signal.aborted) done();
    });
    try {
      view.banner(false);
      await wait(800);
      if (valid()) view.banner(true);
      for (const shot of view.shots([...new Set(ids)])) {
        if (!valid()) break;
        const releases: Array<() => void> = [];
        release = () => { for (const cleanup of releases.splice(0)) cleanup(); };
        try {
          for (const id of shot.ids) releases.push(view.spotlight(id));
          await view.pan(shot.view, duration);
          if (valid()) await wait(900);
        } finally { release(); release = (): void => {}; }
      }
    } finally {
      release(); view.hideBanner();
      try {
        if (this.#restoreCamera && scene === view.scene()) {
          await view.pan(original, abort.signal.aborted ? 0 : duration);
          if (this.#restoreCamera && abort.signal.aborted && scene === view.scene()) await view.pan(original, 0);
        }
      } finally {
        abort.signal.removeEventListener("abort", stop);
        if (this.#abort === abort) this.#abort = null;
      }
    }
  }
}

export class FoundryCinematicView implements CinematicView {
  #banner: HTMLElement | null = null;
  #highlights: PIXI.Container | null = null;
  scene(): unknown { return canvas.scene; }
  camera(): CameraView { return { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x }; }
  reducedMotion(): boolean { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  shots(ids: readonly string[]): ThreatShot[] {
    const size = canvas.grid.size;
    const configured = Number(game.settings.get(MODULE_ID, CINEMATIC_GROUP_DISTANCE_SETTING));
    const span = Number.isFinite(configured) ? Math.max(2, Math.min(20, configured)) : 6;
    const targets = ids.flatMap(id => {
      const token = canvas.tokens.get(id);
      if (!token || token.document.hidden) return [];
      return [{ id, ...token.document.getCenterPoint(), width: token.document.width * size, height: token.document.height * size }];
    });
    return groupThreatShots(targets, span * size, size, { width: window.innerWidth * .7, height: window.innerHeight * .6 });
  }
  async pan(view: CameraView, duration: number): Promise<unknown> {
    if (!duration) { this.stopPan(); canvas.pan(view); return; }
    return canvas.animatePan({ ...view, duration });
  }
  stopPan(): void { foundry.canvas.animation.CanvasAnimation.terminateAnimation("canvas.animatePan"); }
  banner(touring: boolean): void {
    if (!this.#banner) {
      const banner = this.#banner = document.createElement("div");
      banner.className = "egm-threat-announcement";
      banner.setAttribute("role", "status"); banner.setAttribute("aria-live", "polite");
      const style = document.createElement("style");
      style.textContent = `
.egm-threat-announcement { position:fixed; inset:0; z-index:100; pointer-events:none; display:grid; place-items:center; }
.egm-threat-frame { position:relative; text-align:center; padding:28px 72px; min-width:min(620px,85vw); color:#ffe8bb;
 background:linear-gradient(90deg,transparent,#150d13ed 18%,#150d13ed 82%,transparent); text-shadow:0 3px 5px #000,0 0 24px #a32424;
 border-block:1px solid #ab7d48; box-shadow:0 8px 45px #0009; transition:transform .4s ease; }
.egm-threat-frame::before,.egm-threat-frame::after { content:"◆"; position:absolute; top:50%; transform:translateY(-50%); color:#ce9d61; font-size:28px; }
.egm-threat-frame::before { left:18px; } .egm-threat-frame::after { right:18px; }
.egm-threat-title { display:block; font-family:Signika,Georgia,serif; font-size:clamp(32px,4vw,64px); letter-spacing:.1em; text-transform:uppercase; line-height:1.2; }
.egm-threat-ornament { display:block; color:#c66b59; letter-spacing:.6em; font-size:15px; margin-top:12px; }
.egm-threat-announcement.egm-touring { align-items:start; padding-top:7vh; }
.egm-touring .egm-threat-frame { transform:scale(.65); transform-origin:top center; }
@media(prefers-reduced-motion:reduce) { .egm-threat-frame { transition:none; } }
`;
      const frame = document.createElement("div"); frame.className = "egm-threat-frame";
      const title = document.createElement("span"); title.className = "egm-threat-title";
      title.textContent = game.i18n.localize("EGM.Threats.Detected");
      const ornament = document.createElement("span"); ornament.className = "egm-threat-ornament";
      ornament.textContent = "━ ◆ ━"; ornament.setAttribute("aria-hidden", "true");
      frame.append(title, ornament); banner.append(style, frame); document.body.append(banner);
    }
    this.#banner.classList.toggle("egm-touring", touring);
  }
  hideBanner(): void { this.#banner?.remove(); this.#banner = null; }
  highlight(ids: readonly string[]): void {
    this.clearHighlights();
    if (!ids.length || !canvas.interface?.grid) return;
    this.#highlights = new PIXI.Container(); this.#highlights.eventMode = "none";
    canvas.interface.grid.addChild(this.#highlights);
    const g = this.#highlights.addChild(new PIXI.Graphics());
    g.lineStyle(4, 0xff3333, 1).beginFill(0xff3333, .18);
    for (const id of ids) {
      const token = canvas.tokens.get(id);
      if (!token || token.document.hidden) continue;
      const s = token.document._source;
      g.drawRect(s.x, s.y, s.width * canvas.grid.size, s.height * canvas.grid.size);
    }
    g.endFill();
  }
  clearHighlights(): void {
    if (this.#highlights && !this.#highlights.destroyed) this.#highlights.destroy({ children: true });
    this.#highlights = null;
  }
  spotlight(id: string): () => void {
    const token = canvas.tokens.get(id);
    if (!token || token.document.hidden) return () => {};
    const center = token.document.getCenterPoint();
    const radius = canvas.grid.size * (Math.max(token.document.width, token.document.height) / 2 + 1);
    const graphics: PIXI.Graphics[] = [];
    const art = new PIXI.Container();
    let released = false;
    const release = (): void => {
      if (released) return; released = true;
      for (const g of graphics) if (!g.destroyed) g.destroy();
      if (!art.destroyed) art.destroy({ children: true });
      if (canvas.masks?.vision) canvas.masks.vision.renderDirty = true;
    };
    try {
      const vision = canvas.visibility.vision;
      // These preview parents are excluded from fog saves. Shared graphics and token visibility stay untouched.
      for (const parent of [vision?.sight.preview, vision?.light.preview, vision?.light.mask.preview]) {
        if (!parent) continue;
        const circle = new PIXI.Graphics(); graphics.push(circle); parent.addChild(circle);
        circle.beginFill(0xff0000).drawCircle(center.x, center.y, radius).endFill();
      }
      if (canvas.masks?.vision) canvas.masks.vision.renderDirty = true;
      art.eventMode = "none"; canvas.interface.grid.addChild(art);
      if (token.mesh?.texture) {
        const sprite = art.addChild(new PIXI.Sprite(token.mesh.texture));
        sprite.anchor.set(.5); sprite.position.set(center.x, center.y);
        sprite.width = token.document.width * canvas.grid.size; sprite.height = token.document.height * canvas.grid.size;
      }
      art.addChild(new PIXI.Graphics()).lineStyle(4, 0xff3333, 1).drawCircle(center.x, center.y, radius);
      return release;
    } catch (error) { release(); throw error; }
  }
}
