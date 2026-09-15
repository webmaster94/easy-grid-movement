import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasNavigation } from "../src/canvas-navigation";

function setup() {
  const listeners = new Map<string, (event: unknown) => void>();
  vi.stubGlobal("window", { addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name) });
  const hit = vi.fn(() => ({ id: "board" }));
  vi.stubGlobal("document", { elementFromPoint: hit });
  const pan = vi.fn();
  vi.stubGlobal("canvas", { stage: { pivot: { x: 500, y: 600 }, scale: { x: .5 } }, pan });
  vi.stubGlobal("CONFIG", { Canvas: { dragSpeedModifier: 1 } });
  const cancel = vi.fn(), navigate = vi.fn(), navigation = new CanvasNavigation();
  navigation.activate(cancel, navigate);
  const event = (changes = {}) => ({ button: 2, buttons: 2, pointerId: 1, clientX: 100, clientY: 100,
    timeStamp: 0, isTrusted: true, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...changes });
  const send = (name: string, changes = {}) => { const e = event(changes); listeners.get(name)?.(e); return e; };
  return { navigation, send, cancel, navigate, pan, hit, listeners };
}
afterEach(() => vi.unstubAllGlobals());

describe("right click versus canvas pan", () => {
  it("undoes on release of a short click, regardless of context-menu timing", () => {
    const { send, cancel, pan } = setup();
    send("pointerdown"); send("contextmenu"); expect(cancel).not.toHaveBeenCalled();
    send("pointerup", { timeStamp: 180 }); send("contextmenu");
    expect(cancel).toHaveBeenCalledOnce(); expect(pan).not.toHaveBeenCalled();
  });
  it("pans in scene coordinates and never undoes after dragging back to the start", () => {
    const { send, cancel, pan, navigate } = setup();
    send("pointerdown"); send("pointermove", { clientX: 120, clientY: 110 });
    expect(pan).toHaveBeenLastCalledWith({ x: 460, y: 580, scale: .5 });
    send("pointermove"); send("pointerup", { timeStamp: 200 }); send("contextmenu");
    expect(navigate).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled();
  });
  it("ignores a long hold and tolerates small jitter on a short click", () => {
    const { send, cancel, pan } = setup();
    send("pointerdown"); send("pointerup", { timeStamp: 500 }); expect(cancel).not.toHaveBeenCalled();
    send("pointerdown"); send("pointermove", { clientX: 102 }); send("pointerup", { clientX: 102, timeStamp: 100 });
    expect(cancel).toHaveBeenCalledOnce(); expect(pan).not.toHaveBeenCalled();
  });
  it("continues a long drag through synthetic hover updates emitted by canvas pan", () => {
    const { send, cancel, pan, navigate } = setup();
    pan.mockImplementation((view: { x: number; y: number }) => {
      Object.assign(canvas.stage.pivot, view);
      send("pointermove", { clientX: 120, buttons: 0, isTrusted: false });
    });
    send("pointerdown");
    send("pointermove", { clientX: 120 });
    send("pointermove", { clientX: 250 });
    send("pointermove", { clientX: 500 });
    send("pointerup", { clientX: 500, timeStamp: 900 });
    expect(pan).toHaveBeenCalledTimes(3);
    expect(pan).toHaveBeenLastCalledWith({ x: -300, y: 600, scale: .5 });
    expect(navigate).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
  it("preserves a gesture across overlay redraws and resets it on blur", () => {
    const { navigation, send, cancel, navigate, pan, listeners } = setup();
    send("pointerdown"); navigation.activate(cancel, navigate);
    send("pointermove", { clientX: 120 }); expect(pan).toHaveBeenCalledOnce();
    send("blur"); send("pointerup", { timeStamp: 100 }); expect(cancel).not.toHaveBeenCalled();
    navigation.clear(); expect(listeners.size).toBe(0);
  });
  it("ends a drag when a real pointer move reports that the button was released", () => {
    const { send, pan, cancel } = setup();
    send("pointerdown"); send("pointermove", { clientX: 120 });
    send("pointermove", { clientX: 250, buttons: 0 });
    send("pointermove", { clientX: 500 }); send("pointerup", { timeStamp: 200 });
    expect(pan).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled();
  });
  it("leaves sidebar clicks and unrelated buttons untouched", () => {
    const { send, hit, cancel } = setup();
    expect(send("pointerdown", { button: 0 }).preventDefault).not.toHaveBeenCalled();
    hit.mockReturnValue({ id: "sidebar" });
    expect(send("pointerdown").preventDefault).not.toHaveBeenCalled();
    expect(send("contextmenu").preventDefault).not.toHaveBeenCalled();
    send("pointerup", { timeStamp: 100 }); expect(cancel).not.toHaveBeenCalled();
  });
});
