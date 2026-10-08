import { Backend } from './backend';
import { FIXED_DT, InputState, PRESETS, SimSettings, StepParams, clonePreset } from './config';
import { createGui } from './gui';
import { MAX_RADIUS, MIN_RADIUS, createPointerInput } from './input';
import { App, AppState, createKeyboard } from './keyboard';
import { spawnAgents } from './spawn';
import { createWebGPUBackend } from './webgpu/gpuBackend';
import { createWebGL2Backend } from './webgl2/glBackend';

/** Cap on fixed ticks per animation frame so a slow GPU doesn't spiral. */
const MAX_TICKS_PER_FRAME = 4;

const canvas = document.getElementById('sim') as HTMLCanvasElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const errorEl = document.getElementById('error') as HTMLDivElement;
const helpEl = document.getElementById('help') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;
const aboutEl = document.getElementById('about') as HTMLDivElement;

function fail(msg: string): never {
  errorEl.textContent = msg;
  errorEl.style.display = 'flex';
  throw new Error(msg);
}

async function pickBackend(): Promise<Backend> {
  const forced = new URLSearchParams(location.search).get('backend');
  if (forced !== 'webgl2') {
    try {
      return await createWebGPUBackend(canvas);
    } catch (e) {
      if (forced === 'webgpu') fail(`WebGPU unavailable: ${(e as Error).message}`);
      console.warn('WebGPU unavailable, falling back to WebGL2:', e);
    }
  }
  try {
    return createWebGL2Backend(canvas);
  } catch (e) {
    fail(`This browser supports neither WebGPU nor WebGL2 with float render targets (${(e as Error).message}).`);
  }
}

async function main() {
  const backend = await pickBackend();
  const params = new URLSearchParams(location.search);
  const requested = params.get('preset')?.toUpperCase() ?? 'A';
  let presetName = requested in PRESETS ? requested : 'A';
  const settings = clonePreset(presetName);
  const agentsParam = Number(params.get('agents'));
  if (agentsParam > 0 && agentsParam !== settings.numAgents) {
    settings.numAgents = agentsParam;
    presetName += '*';
  }

  const input: InputState = {
    brush: { x: 0, y: 0, radius: 80, strength: 1, action: 'none' },
    food: [],
    foodStrength: 5,
  };
  const state: AppState = {
    settings,
    presetName,
    view: { zoom: 1, cx: settings.width / 2, cy: settings.height / 2 },
    input,
    paused: false,
    tools: { spawnCount: 2000, touchAction: 'attract' },
    uiHidden: false,
  };

  const pointer = createPointerInput(canvas, state.view, input, { touchAction: () => state.tools.touchAction });
  let simTime = 0;
  let savePending = false;
  let wallFrom: { x: number; y: number } | null = null; // last stamped wall brush position

  const respawn = (s: SimSettings) => {
    s.numAgents = Math.min(s.numAgents, backend.maxAgents);
    const resized = canvas.width !== s.width || canvas.height !== s.height;
    canvas.width = s.width;
    canvas.height = s.height;
    if (resized) {
      state.view.zoom = 1;
      pointer.clampView();
      input.food = input.food.filter((f) => f.x < s.width && f.y < s.height);
    }
    simTime = 0;
    backend.init(s, spawnAgents(s));
  };

  // Help and About share the screen centre, so opening one closes the other.
  const setOverlay = (el: HTMLElement, show: boolean) => {
    for (const o of [helpEl, aboutEl]) o.classList.toggle('open', o === el ? show : show ? false : o.classList.contains('open'));
    if (show) hintEl.classList.add('gone');
  };

  const app: App = {
    state,
    togglePause: () => {
      state.paused = !state.paused;
    },
    reset: () => respawn(state.settings),
    loadPreset: (name) => {
      if (!(name in PRESETS)) return;
      state.settings = clonePreset(name);
      state.presetName = name;
      respawn(state.settings);
      gui.rebuild();
    },
    markModified: () => {
      if (!state.presetName.endsWith('*')) state.presetName += '*';
    },
    clearTrail: () => backend.clearTrail(),
    clearWalls: () => backend.clearWalls(),
    clearFood: () => {
      input.food.length = 0;
    },
    toggleAgentsOnly: () => {
      state.settings.showAgentsOnly = !state.settings.showAgentsOnly;
    },
    toggleJones: () => {
      state.settings.jonesMode = !state.settings.jonesMode;
      app.markModified();
    },
    toggleUI: () => {
      state.uiHidden = !state.uiHidden;
      gui.setVisible(!state.uiHidden);
      statsEl.style.display = state.uiHidden ? 'none' : '';
      hintEl.classList.add('gone');
    },
    scaleBrush: (f) => {
      // At least 1 px per step, so ']' can grow the brush back from the minimum.
      const r = input.brush.radius;
      const next = f > 1 ? Math.max(r + 1, Math.round(r * f)) : Math.min(r - 1, Math.round(r * f));
      input.brush.radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, next));
    },
    resetView: () => {
      state.view.zoom = 1;
      pointer.clampView();
    },
    savePng: () => {
      savePending = true;
    },
    toggleHelp: (show) => setOverlay(helpEl, show ?? !helpEl.classList.contains('open')),
    toggleAbout: (show) => setOverlay(aboutEl, show ?? !aboutEl.classList.contains('open')),
  };

  respawn(state.settings);
  const gui = createGui(app, backend.maxAgents, backend.name);
  createKeyboard(app, pointer);
  for (const el of [helpEl, aboutEl]) {
    el.addEventListener('click', (e) => {
      if (e.target === el || (e.target as HTMLElement).closest('.close')) setOverlay(el, false);
    });
  }
  setTimeout(() => hintEl.classList.add('gone'), 5000);

  let last = performance.now();
  let accumulator = 0;
  let frames = 0;
  let fpsTime = last;
  let fps = 0;
  const stepParams: StepParams = { settings: state.settings, time: 0, dt: FIXED_DT, input };

  const frame = (now: number) => {
    const s = state.settings;
    accumulator += Math.min(0.25, (now - last) / 1000);
    last = now;
    pointer.update();

    // Walls are stamped once per step() call (50 Hz), so fill in fast strokes and allow edits while paused.
    const b = input.brush;
    if (b.action === 'wall' || b.action === 'unwall') {
      stepParams.settings = s;
      const { x, y } = b;
      if (!wallFrom) {
        if (state.paused) backend.step(stepParams, 0);
        wallFrom = { x, y };
      } else {
        const spacing = Math.max(1, b.radius * 0.5);
        const dist = Math.hypot(x - wallFrom.x, y - wallFrom.y);
        if (dist >= spacing) {
          const n = Math.min(64, Math.ceil(dist / spacing));
          for (let i = 1; i <= n; i++) {
            b.x = wallFrom.x + ((x - wallFrom.x) * i) / n;
            b.y = wallFrom.y + ((y - wallFrom.y) * i) / n;
            backend.step(stepParams, 0);
          }
          b.x = x;
          b.y = y;
          wallFrom = { x, y };
        }
      }
    } else wallFrom = null;

    // Unity runs RunSimulation() stepsPerFrame times per FixedUpdate (50 Hz).
    let ticks = 0;
    while (accumulator >= FIXED_DT && ticks < MAX_TICKS_PER_FRAME) {
      if (!state.paused) {
        if (pointer.spawning) {
          backend.spawnAt(b.x, b.y, b.radius, Math.min(state.tools.spawnCount, s.numAgents), s);
        }
        stepParams.settings = s;
        stepParams.time = simTime;
        backend.step(stepParams, s.stepsPerFrame);
        simTime += FIXED_DT;
      }
      accumulator -= FIXED_DT;
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_FRAME) accumulator = 0;
    backend.render(s, state.view, input.food);

    // Same task as render(), so the drawing buffer is still valid without preserveDrawingBuffer.
    if (savePending) {
      savePending = false;
      const name = `slime-${state.presetName.replace('*', '-custom')}.png`;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, 'image/png');
    }

    frames++;
    if (now - fpsTime >= 500) {
      fps = (frames * 1000) / (now - fpsTime);
      frames = 0;
      fpsTime = now;
      const v = state.view;
      statsEl.textContent =
        `${backend.name}  ${fps.toFixed(0)} fps${state.paused ? '  PAUSED' : ''}\n` +
        `${s.numAgents.toLocaleString()} agents  ${s.width}x${s.height}  ${s.species.length} species` +
        (v.zoom > 1 ? `  ${v.zoom.toFixed(1)}x` : '');
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Exposed for automated verification/benchmarks.
  (window as unknown as { slime: unknown }).slime = {
    ...app,
    backend: backend.name,
    app,
    pointer,
    get fps() {
      return fps;
    },
  };
}

main().catch((e) => {
  console.error(e);
  if (errorEl.style.display !== 'flex') fail(String(e));
});
