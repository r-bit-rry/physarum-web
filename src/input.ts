import { BrushAction, InputState, MAX_FOOD, View } from './config';

/** Anything a single-finger touch drag can do. */
export type PrimaryAction = Exclude<BrushAction, 'none'> | 'spawn';

export interface InputHooks {
  /** Action for a one-finger touch drag. */
  touchAction(): PrimaryAction;
}

export interface PointerController {
  /** True while an Alt-drag (or touch spawn) is active, or E is held with the pointer over the canvas. */
  readonly spawning: boolean;
  /** Set by keyboard.ts while E is held. */
  keySpawn: boolean;
  /** Set by keyboard.ts while Space is held: left-drag pans. */
  spaceHeld: boolean;
  /** Set when a pan happens, so keyboard.ts can tell a Space tap from Space + drag. */
  panned: boolean;
  /** Re-derive brush position/action and the overlay from the last pointer position. Call once per frame. */
  update(): void;
  /** Re-apply the zoom/centre limits (after the canvas is resized). */
  clampView(): void;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 16;
export const MIN_RADIUS = 3;
export const MAX_RADIUS = 400;
/** A press only starts brushing after this long or after moving, so a double-click (food) doesn't also brush. */
const HOLD_MS = 150;
const HOLD_PX = 4;

const COLOURS: Record<PrimaryAction, string> = {
  attract: '#3ef',
  repel: '#f93',
  paint: '#4e6',
  erase: '#999',
  wall: '#fff',
  unwall: '#fff',
  spawn: '#f4f',
};

type Gesture = 'none' | 'pan' | PrimaryAction;
type Pt = { x: number; y: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Maps mouse/touch/wheel gestures onto input.brush (sim coords, y up) and the view (zoom/pan).
 * Screen -> sim accounts for object-fit: contain letterboxing and the inverse View transform.
 */
export function createPointerInput(
  canvas: HTMLCanvasElement,
  view: View,
  input: InputState,
  hooks: InputHooks,
): PointerController {
  const overlay = (document.getElementById('brush') as HTMLDivElement | null) ?? document.body.appendChild(document.createElement('div'));
  const mods = { shift: false, ctrl: false, alt: false };
  const touches = new Map<number, Pt>();
  let last: Pt | null = null; // client coords of the mouse / active finger
  let inside = false;
  let gesture: Gesture = 'none';
  let pinch: { mid: Pt; dist: number } | null = null;
  let touchBlocked = false; // after a pinch, ignore the remaining finger until all are lifted
  let lastWasTouch = false; // touch has no hover, so hide the overlay when no finger is down
  let downAt = 0; // time and client position of the press that started `gesture`
  const downPos: Pt = { x: 0, y: 0 };
  let moved = false;

  // The element rect is cached (no forced layout per frame); canvas.width/height are read live.
  let rect: DOMRect | null = null;
  const invalidate = () => (rect = null);
  new ResizeObserver(invalidate).observe(canvas);
  window.addEventListener('resize', invalidate);
  window.addEventListener('scroll', invalidate, true);
  const L = { scale: 1, left: 0, top: 0 };
  const layout = () => {
    const r = (rect ??= canvas.getBoundingClientRect());
    L.scale = Math.min(r.width / canvas.width, r.height / canvas.height);
    L.left = r.left + (r.width - canvas.width * L.scale) / 2;
    L.top = r.top + (r.height - canvas.height * L.scale) / 2;
    return L;
  };
  /** Client coords -> canvas pixels (y down). */
  const toCanvas = (c: Pt, out: Pt = { x: 0, y: 0 }): Pt => {
    const l = layout();
    out.x = (c.x - l.left) / l.scale;
    out.y = (c.y - l.top) / l.scale;
    return out;
  };
  /** Canvas pixels -> sim coords (y up). In-place safe. */
  const toSim = (p: Pt, out: Pt = { x: 0, y: 0 }): Pt => {
    const x = (p.x - canvas.width / 2) / view.zoom + view.cx;
    out.y = (canvas.height / 2 - p.y) / view.zoom + view.cy;
    out.x = x;
    return out;
  };
  const scratch: Pt = { x: 0, y: 0 };

  /** Start the hold timer for a new press. */
  const press = (c: Pt) => {
    downAt = performance.now();
    downPos.x = c.x;
    downPos.y = c.y;
    moved = false;
  };
  const armed = () => moved || performance.now() - downAt >= HOLD_MS;

  // Overlay/cursor style writes are skipped when unchanged.
  const styleCache = new Map<string, string>();
  const css = (el: HTMLElement, prop: 'display' | 'left' | 'top' | 'width' | 'height' | 'borderColor' | 'borderStyle' | 'opacity' | 'cursor', v: string) => {
    const key = el === canvas ? 'c' + prop : prop;
    if (styleCache.get(key) === v) return;
    styleCache.set(key, v);
    el.style[prop] = v;
  };

  const clampView = () => {
    const W = canvas.width;
    const H = canvas.height;
    view.zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
    if (view.zoom === MIN_ZOOM) {
      view.cx = W / 2;
      view.cy = H / 2;
      return;
    }
    const hw = W / (2 * view.zoom);
    const hh = H / (2 * view.zoom);
    view.cx = clamp(view.cx, hw, W - hw);
    view.cy = clamp(view.cy, hh, H - hh);
  };

  /** Zoom keeping the sim point under `client` fixed on screen. */
  const zoomAbout = (client: Pt, zoom: number) => {
    const p = toCanvas(client);
    const s = toSim(p);
    view.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    view.cx = s.x - (p.x - canvas.width / 2) / view.zoom;
    view.cy = s.y - (canvas.height / 2 - p.y) / view.zoom;
    clampView();
  };

  const panBy = (dx: number, dy: number) => {
    const k = layout().scale * view.zoom;
    view.cx -= dx / k;
    view.cy += dy / k;
    clampView();
    if (dx || dy) ctl.panned = true;
  };

  const mouseGesture = (buttons: number): Gesture => {
    if (buttons & 4 || (buttons & 1 && ctl.spaceHeld)) return 'pan';
    if (!(buttons & 3)) return 'none';
    if (mods.alt) return 'spawn';
    const right = !(buttons & 1);
    if (mods.ctrl) return right ? 'unwall' : 'wall';
    if (mods.shift) return right ? 'erase' : 'paint';
    return right ? 'repel' : 'attract';
  };

  /** What the overlay shows while hovering (what a left-drag would do now). */
  const hoverAction = (): PrimaryAction =>
    mods.alt || ctl.keySpawn ? 'spawn' : mods.ctrl ? 'wall' : mods.shift ? 'paint' : 'attract';

  const setMods = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) => {
    mods.shift = e.shiftKey;
    mods.ctrl = e.ctrlKey || e.metaKey;
    mods.alt = e.altKey;
  };

  const ctl: PointerController = {
    get spawning() {
      return (gesture === 'spawn' && armed()) || (ctl.keySpawn && inside && last !== null && gesture === 'none');
    },
    keySpawn: false,
    spaceHeld: false,
    panned: false,
    clampView,
    update() {
      const b = input.brush;
      const g = gesture;
      b.action = g === 'none' || g === 'pan' || g === 'spawn' || !armed() ? 'none' : g;
      if (last) {
        const s = toSim(toCanvas(last, scratch), scratch);
        b.x = s.x;
        b.y = s.y;
      }
      const touchIdle = touches.size === 0 && gesture === 'none' && lastWasTouch;
      const show = inside && last && g !== 'pan' && !pinch && !touchIdle;
      css(canvas, 'cursor', g === 'pan' ? 'grabbing' : ctl.spaceHeld ? 'grab' : 'crosshair');
      if (!show) {
        css(overlay, 'display', 'none');
        return;
      }
      const d = `${2 * b.radius * view.zoom * layout().scale}px`;
      css(overlay, 'display', 'block');
      css(overlay, 'left', `${last!.x}px`);
      css(overlay, 'top', `${last!.y}px`);
      css(overlay, 'width', d);
      css(overlay, 'height', d);
      css(overlay, 'borderColor', COLOURS[g === 'none' ? hoverAction() : g]);
      css(overlay, 'borderStyle', g === 'unwall' ? 'dashed' : 'solid');
      css(overlay, 'opacity', g === 'none' || !armed() ? '0.5' : '0.9');
    },
  };

  // Mouse / pen.
  const onMouse = (e: PointerEvent) => {
    setMods(e);
    const prev = last;
    last = { x: e.clientX, y: e.clientY };
    inside = true;
    lastWasTouch = false;
    // Only presses that started on the canvas (and so were captured) brush or pan; a GUI slider
    // drag that wanders over the canvas is just a hover.
    const g = mouseGesture(canvas.hasPointerCapture(e.pointerId) ? e.buttons : 0);
    if (g === 'pan' && gesture === 'pan' && prev) panBy(last.x - prev.x, last.y - prev.y);
    if (g !== 'none' && gesture === 'none') press(last);
    else if (!moved && Math.hypot(last.x - downPos.x, last.y - downPos.y) > HOLD_PX) moved = true;
    gesture = g;
    ctl.update();
  };

  // Touch: one finger = primary action, two = pinch zoom + pan.
  const twoFingers = (): { mid: Pt; dist: number } => {
    const [a, b] = [...touches.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  };
  const onTouchDown = (e: PointerEvent) => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastWasTouch = true;
    inside = true;
    if (touches.size === 1 && !touchBlocked) {
      last = { x: e.clientX, y: e.clientY };
      gesture = hooks.touchAction();
      press(last);
    } else if (touches.size >= 2) {
      gesture = 'none';
      pinch = twoFingers(); // re-seed when a third finger lands too
      touchBlocked = true;
    }
    ctl.update();
  };
  const onTouchMove = (e: PointerEvent) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size >= 2) {
      const now = twoFingers();
      // Keep the sim point under the old midpoint under the new one, at the new zoom.
      const s = toSim(toCanvas(pinch.mid));
      view.zoom = clamp(view.zoom * (now.dist / pinch.dist), MIN_ZOOM, MAX_ZOOM);
      const p = toCanvas(now.mid);
      view.cx = s.x - (p.x - canvas.width / 2) / view.zoom;
      view.cy = s.y - (canvas.height / 2 - p.y) / view.zoom;
      clampView();
      pinch = now;
    } else if (!touchBlocked) {
      last = { x: e.clientX, y: e.clientY };
      if (!moved && Math.hypot(last.x - downPos.x, last.y - downPos.y) > HOLD_PX) moved = true;
    }
    ctl.update();
  };
  const onTouchUp = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    // The remaining pair may differ from the one `pinch` tracked, so re-seed.
    pinch = touches.size >= 2 ? twoFingers() : null;
    if (touches.size === 0) touchBlocked = false;
    gesture = 'none';
    ctl.update();
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') onTouchDown(e);
    else {
      if (e.button === 1) e.preventDefault(); // no autoscroll
      onMouse(e);
    }
  });
  canvas.addEventListener('pointermove', (e) => (e.pointerType === 'touch' ? onTouchMove(e) : onMouse(e)));
  const release = (e: PointerEvent) => (e.pointerType === 'touch' ? onTouchUp(e) : onMouse(e));
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', (e) => {
    if (e.pointerType === 'touch') onTouchUp(e);
    else {
      gesture = 'none';
      ctl.update();
    }
  });
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch' && touches.size > 0) return;
    inside = false;
    gesture = 'none';
    ctl.update();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('dblclick', (e) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return; // modifier clicks are brush strokes
    const s = toSim(toCanvas({ x: e.clientX, y: e.clientY }));
    if (s.x < 0 || s.y < 0 || s.x >= canvas.width || s.y >= canvas.height) return;
    const food = input.food;
    const reach = 12 / view.zoom;
    let best = -1;
    let bestD = reach;
    food.forEach((f, i) => {
      const d = Math.hypot(f.x - s.x, f.y - s.y);
      if (d <= bestD) [best, bestD] = [i, d];
    });
    if (best >= 0) food.splice(best, 1);
    else if (food.length < MAX_FOOD) food.push(s);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // No setMods here: a trackpad pinch arrives as a synthetic ctrlKey wheel with no keyup.
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      // On some platforms Alt+wheel arrives as horizontal scroll.
      const dAlt = dy || e.deltaX * (e.deltaMode === 1 ? 16 : 1);
      last = { x: e.clientX, y: e.clientY };
      inside = true;
      lastWasTouch = false;
      if (e.altKey) input.brush.radius = clamp(input.brush.radius * Math.exp(-dAlt * 0.002), MIN_RADIUS, MAX_RADIUS);
      else {
        // Trackpad pinch = ctrlKey with small pixel deltas, so a stronger factor. Ctrl + mouse wheel
        // (large deltas) gets the normal one.
        const pinchLike = e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaY) < 50;
        zoomAbout(last, view.zoom * Math.exp(-dy * (pinchLike ? 0.01 : 0.0015)));
      }
      ctl.update();
    },
    { passive: false },
  );

  // Modifier changes while hovering update the overlay colour; Alt must not focus the browser menu.
  const onKey = (e: KeyboardEvent) => {
    setMods(e);
    if (e.key === 'Alt') e.preventDefault();
  };
  window.addEventListener('keydown', onKey, true); // capture: lil-gui stops key propagation
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', () => {
    mods.shift = mods.ctrl = mods.alt = false;
    gesture = 'none';
    touches.clear();
    pinch = null;
    touchBlocked = false;
    ctl.update();
  });

  return ctl;
}
