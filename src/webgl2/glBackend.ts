// WebGL2 fallback backend. Requires EXT_color_buffer_float (render to RGBA32F/RGBA16F).
//
// Per step:
//   1. agents pass: fragment shader over a square RGBA32F agent texture (x, y, angle, species),
//      sensing the current trail with texelFetch, written into a ping-pong agent texture.
//   2. deposit: gl.POINTS, one per agent, additive blend (ONE, ONE) into the trail. The trail is
//      RGBA32F when EXT_float_blend is available, else RGBA16F (iOS lacks 32F blending).
//   3. diffuse: trail -> trail2 fragment pass (min(1) clamp, 3x3 blur, decay, food, brush paint/erase,
//      walls zeroed).
// Walls are an R8 mask texture; wall/unwall brush edits draw into it once per step() call, before the
// substeps (scissored full-screen pass that discards outside the brush disc).
//
// Behavioural differences from SlimeSim.compute (and the WebGPU backend):
//   - Deposits happen after every agent has moved, so agents never sense deposits made earlier
//     in the same step (the HLSL reads and writes the trail in one racy pass).
//   - Blending sums every deposit, so there are no lost writes when agents share a cell. Seb's
//     per-write min(1, trail + d) is applied once at the start of the diffuse pass, which gives
//     the same result as sequential clamped writes.
//   - On the RGBA16F path: the diffuse store is stochastically rounded so small decay rates still
//     fade the trail (on average). In jonesMode the trail is capped at 60000 to avoid Inf/NaN, and
//     once a cell passes ~256 a single deposit (0.1 at preset defaults) is below half an fp16 ulp
//     and is lost, so busy jonesMode cells saturate at a few hundred instead of growing like f32.
//   - Brush paint can push values above 1 in Seb's mode; the next diffuse pass clamps them back to
//     1 (the WebGPU backend keeps them until a deposit clamps the cell).
//   - Clamped and wall-blocked agents are flagged by adding 4 to the stored species index so they skip
//     the deposit.

import { Backend } from '../backend';
import { BrushAction, MAX_FOOD, MAX_SPECIES, SimSettings, StepParams, View } from '../config';
import fullscreenVert from './fullscreen.vert?raw';
import agentsFrag from './agents.frag?raw';
import depositVert from './deposit.vert?raw';
import depositFrag from './deposit.frag?raw';
import diffuseFrag from './diffuse.frag?raw';
import renderFrag from './render.frag?raw';
import agentsOnlyVert from './agentsOnly.vert?raw';
import agentsOnlyFrag from './agentsOnly.frag?raw';
import wallEditFrag from './wallEdit.frag?raw';

interface Program {
  prog: WebGLProgram;
  u: (name: string) => WebGLUniformLocation | null;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

// Texture units: agents on 0, trail on 1, walls on 2.
const AGENT_UNIT = 0;
const TRAIL_UNIT = 1;
const WALL_UNIT = 2;

/** Shader brush action codes, shared with the WebGPU backend. */
const BRUSH_CODE: Record<BrushAction, number> = { none: 0, attract: 1, repel: 2, paint: 3, erase: 4, wall: 5, unwall: 6 };

export function createWebGL2Backend(canvas: HTMLCanvasElement): Backend {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 not supported');

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  // The plan caps this path at ~1M agents (measured ~5 fps at 4M).
  const maxAgents = Math.min(maxTex * maxTex, 1_000_000);

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(sh)}`);
    return sh;
  };

  const program = (vs: string, fs: string): Program => {
    const prog = gl.createProgram()!;
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
    gl.deleteShader(v);
    gl.deleteShader(f);
    const cache = new Map<string, WebGLUniformLocation | null>();
    const u = (name: string) => {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
      return cache.get(name)!;
    };
    return { prog, u };
  };

  // Programs, VAO and extensions; rebuilt after a context restore.
  let agentsProg: Program, depositProg: Program, diffuseProg: Program, renderProg: Program, agentsOnlyProg: Program;
  let wallEditProg: Program;
  let vao: WebGLVertexArrayObject | null = null;
  let trail32 = false;

  const setup = () => {
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float not supported');
    trail32 = !!gl.getExtension('EXT_float_blend');
    agentsProg = program(fullscreenVert, agentsFrag);
    depositProg = program(depositVert, depositFrag);
    diffuseProg = program(fullscreenVert, diffuseFrag);
    renderProg = program(fullscreenVert, renderFrag);
    agentsOnlyProg = program(agentsOnlyVert, agentsOnlyFrag);
    wallEditProg = program(fullscreenVert, wallEditFrag);

    // Fixed sampler-unit bindings.
    for (const p of [agentsProg, depositProg, agentsOnlyProg]) {
      gl.useProgram(p.prog);
      gl.uniform1i(p.u('uAgents'), AGENT_UNIT);
    }
    for (const p of [agentsProg, diffuseProg, renderProg]) {
      gl.useProgram(p.prog);
      gl.uniform1i(p.u('uTrail'), TRAIL_UNIT);
      gl.uniform1i(p.u('uWalls'), WALL_UNIT);
    }

    // All draws are attribute-less; WebGL2 still wants a VAO bound.
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  };
  setup();

  // Per-step uniform scratch, reused to avoid per-frame allocations.
  const speciesParams = new Float32Array(16);
  const sensorSizes = new Int32Array(4);
  const colours = new Float32Array(12);
  const foodPos = new Float32Array(MAX_FOOD * 2);
  let spawnScratch = new Float32Array(0); // spawnAt staging, grown on demand

  const packFood = (food: { x: number; y: number }[]) => {
    const n = Math.min(food.length, MAX_FOOD);
    for (let i = 0; i < n; i++) {
      foodPos[i * 2] = food[i].x;
      foodPos[i * 2 + 1] = food[i].y;
    }
    return n;
  };

  let agents: Target[] = [];
  let trail: Target[] = [];
  let walls: Target | null = null;
  let spawnCursor = 0;
  let side = 1;
  let width = 1;
  let height = 1;
  let numAgents = 0;
  let lost = false;
  let lastInit: { settings: SimSettings; data: Float32Array } | null = null;

  const createTarget = (
    w: number,
    h: number,
    internal: number,
    type: number,
    data: ArrayBufferView | null,
    format: number = gl.RGBA,
  ): Target => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Framebuffer incomplete');
    }
    return { tex, fbo };
  };

  const deleteTargets = (ts: Target[]) => {
    for (const t of ts) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
  };

  const release = () => {
    deleteTargets([...agents, ...trail, ...(walls ? [walls] : [])]);
    agents = [];
    trail = [];
    walls = null;
  };

  const bind = (unit: number, tex: WebGLTexture | null) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  };

  const fullscreen = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

  const swap = (pair: Target[]) => pair.push(pair.shift()!);

  const init = (settings: SimSettings, data: Float32Array) => {
    release();
    lastInit = { settings: { ...settings }, data }; // snapshot size/count for a context restore
    spawnCursor = 0;
    if (lost) return;
    width = settings.width;
    height = settings.height;
    numAgents = Math.min(settings.numAgents, maxAgents);
    side = Math.max(1, Math.ceil(Math.sqrt(numAgents)));
    const padded = new Float32Array(side * side * 4);
    padded.set(data.subarray(0, numAgents * 4));

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Build into a local list so a failed allocation doesn't leak the earlier targets.
    const made: Target[] = [];
    try {
      made.push(createTarget(side, side, gl.RGBA32F, gl.FLOAT, padded));
      made.push(createTarget(side, side, gl.RGBA32F, gl.FLOAT, null));
      // New textures are zero-initialised, which clears the trail.
      const [fmt, type] = trail32 ? [gl.RGBA32F, gl.FLOAT] : [gl.RGBA16F, gl.HALF_FLOAT];
      made.push(createTarget(width, height, fmt, type, null));
      made.push(createTarget(width, height, fmt, type, null));
      made.push(createTarget(width, height, gl.R8, gl.UNSIGNED_BYTE, null, gl.RED));
    } catch (e) {
      deleteTargets(made);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      throw e;
    }
    agents = made.slice(0, 2);
    trail = made.slice(2, 4);
    walls = made[4];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  // Context loss is common on mobile: stop drawing, then rebuild everything and re-init from the
  // last spawn data once the context comes back (the simulation restarts).
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    agents = [];
    trail = [];
    walls = null;
  };
  const onRestored = () => {
    lost = false;
    setup();
    if (lastInit) init(lastInit.settings, lastInit.data);
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  const clearTargets = (ts: Target[]) => {
    gl.clearColor(0, 0, 0, 0);
    for (const t of ts) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  // Write 1 (wall) or 0 (unwall) for cells whose centre is within radius of (x, y).
  const editWalls = (x: number, y: number, radius: number, value: number) => {
    const x0 = Math.max(0, Math.floor(x - radius));
    const y0 = Math.max(0, Math.floor(y - radius));
    const x1 = Math.min(width, Math.ceil(x + radius) + 1);
    const y1 = Math.min(height, Math.ceil(y + radius) + 1);
    if (x1 <= x0 || y1 <= y0) return;
    gl.useProgram(wallEditProg.prog);
    gl.uniform3f(wallEditProg.u('uBrush'), x, y, radius);
    gl.uniform1f(wallEditProg.u('uValue'), value);
    gl.bindFramebuffer(gl.FRAMEBUFFER, walls!.fbo);
    gl.viewport(0, 0, width, height);
    bind(WALL_UNIT, null); // avoid a feedback loop
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, y0, x1 - x0, y1 - y0);
    fullscreen();
    gl.disable(gl.SCISSOR_TEST);
  };

  // Upload agents [start, start + n) into the current agent texture as row segments.
  const uploadAgents = (start: number, data: Float32Array) => {
    const n = data.length / 4;
    let i = 0;
    while (i < n) {
      const idx = start + i;
      const x = idx % side;
      const y = Math.floor(idx / side);
      // Partial first row, then as many full rows as fit, then the partial last row.
      const rows = x === 0 ? Math.max(1, Math.floor((n - i) / side)) : 1;
      const w = rows > 1 ? side : Math.min(side - x, n - i);
      const count = rows > 1 ? rows * side : w;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, rows, gl.RGBA, gl.FLOAT, data.subarray(i * 4, (i + count) * 4));
      i += count;
    }
  };

  return {
    name: 'webgl2',
    maxAgents,
    init,

    step({ settings, time, dt, input }: StepParams, steps: number) {
      if (!agents.length || lost) return;
      const numSpecies = Math.min(settings.species.length, MAX_SPECIES);
      const jones = settings.jonesMode;
      const b = input.brush;
      const action = BRUSH_CODE[b.action] ?? 0;

      if (action === 5 || action === 6) editWalls(b.x, b.y, b.radius, action === 5 ? 1 : 0);
      if (steps <= 0) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return;
      }

      speciesParams.fill(0);
      sensorSizes.fill(0);
      for (let i = 0; i < numSpecies; i++) {
        const s = settings.species[i];
        speciesParams[i * 4] = s.moveSpeed;
        speciesParams[i * 4 + 1] = s.turnSpeed;
        speciesParams[i * 4 + 2] = s.sensorAngleSpacing;
        speciesParams[i * 4 + 3] = s.sensorOffsetDst;
        sensorSizes[i] = Math.round(s.sensorSize);
      }
      const foodCount = packFood(input.food);

      gl.useProgram(agentsProg.prog);
      gl.uniform2i(agentsProg.u('uSize'), width, height);
      gl.uniform1i(agentsProg.u('uSide'), side);
      gl.uniform1i(agentsProg.u('uNumAgents'), numAgents);
      gl.uniform1i(agentsProg.u('uNumSpecies'), numSpecies);
      // HLSL's uint(time * 100000) wraps; uint() of an out-of-range float is undefined in GLSL.
      gl.uniform1ui(agentsProg.u('uTimeSeed'), (time * 100000) >>> 0);
      gl.uniform1f(agentsProg.u('uDt'), dt);
      gl.uniform1i(agentsProg.u('uJones'), jones ? 1 : 0);
      gl.uniform4fv(agentsProg.u('uSpecies'), speciesParams);
      gl.uniform1iv(agentsProg.u('uSensorSize'), sensorSizes);
      gl.uniform1i(agentsProg.u('uBrushAction'), action);
      gl.uniform4f(agentsProg.u('uBrush'), b.x, b.y, b.radius, Math.min(1, b.strength * dt * 5));

      gl.useProgram(depositProg.prog);
      gl.uniform1i(depositProg.u('uSide'), side);
      gl.uniform2i(depositProg.u('uSize'), width, height);
      gl.uniform1i(depositProg.u('uNumSpecies'), numSpecies);
      gl.uniform1f(depositProg.u('uAmount'), settings.trailWeight * dt);

      gl.useProgram(diffuseProg.prog);
      gl.uniform2i(diffuseProg.u('uSize'), width, height);
      gl.uniform1i(diffuseProg.u('uJones'), jones ? 1 : 0);
      gl.uniform1f(diffuseProg.u('uDiffuseWeight'), Math.min(1, Math.max(0, settings.diffuseRate * dt)));
      gl.uniform1f(diffuseProg.u('uDecay'), settings.decayRate * dt);
      gl.uniform1i(diffuseProg.u('uNumSpecies'), numSpecies);
      gl.uniform1i(diffuseProg.u('uBrushAction'), action);
      gl.uniform4f(diffuseProg.u('uBrush'), b.x, b.y, b.radius, b.strength * dt * 2);
      gl.uniform2fv(diffuseProg.u('uFood'), foodPos);
      gl.uniform1i(diffuseProg.u('uFoodCount'), foodCount);
      gl.uniform1f(diffuseProg.u('uFoodAmount'), input.foodStrength * dt);
      gl.uniform1f(diffuseProg.u('uCeil'), trail32 ? 3.4e38 : 60000);
      gl.uniform1i(diffuseProg.u('uDither'), trail32 ? 0 : 1);

      bind(WALL_UNIT, walls!.tex);
      for (let i = 0; i < steps; i++) {
        // 1. Agents: agents[0] + trail[0] -> agents[1]
        gl.useProgram(agentsProg.prog);
        gl.bindFramebuffer(gl.FRAMEBUFFER, agents[1].fbo);
        gl.viewport(0, 0, side, side);
        bind(AGENT_UNIT, agents[0].tex);
        bind(TRAIL_UNIT, trail[0].tex);
        fullscreen();
        swap(agents);

        // 2. Deposit new agent positions into trail[0]. Unbind it as a sampler to avoid a feedback loop.
        gl.useProgram(depositProg.prog);
        gl.bindFramebuffer(gl.FRAMEBUFFER, trail[0].fbo);
        gl.viewport(0, 0, width, height);
        bind(TRAIL_UNIT, null);
        bind(AGENT_UNIT, agents[0].tex);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArrays(gl.POINTS, 0, numAgents);
        gl.disable(gl.BLEND);

        // 3. Diffuse trail[0] -> trail[1]
        gl.useProgram(diffuseProg.prog);
        if (!trail32) gl.uniform1ui(diffuseProg.u('uSeed'), (Math.random() * 4294967296) >>> 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, trail[1].fbo);
        bind(TRAIL_UNIT, trail[0].tex);
        fullscreen();
        swap(trail);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    render(settings: SimSettings, view: View, food: { x: number; y: number }[]) {
      if (!agents.length || lost) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const cw = gl.drawingBufferWidth;
      const ch = gl.drawingBufferHeight;
      gl.viewport(0, 0, cw, ch);
      const zoom = Math.max(view.zoom, 1e-3);
      const foodCount = packFood(food);
      const overlay = settings.showAgentsOnly;

      if (overlay) {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(agentsOnlyProg.prog);
        gl.uniform1i(agentsOnlyProg.u('uSide'), side);
        gl.uniform2i(agentsOnlyProg.u('uSize'), width, height);
        gl.uniform2f(agentsOnlyProg.u('uCanvas'), cw, ch);
        gl.uniform3f(agentsOnlyProg.u('uView'), zoom, view.cx, view.cy);
        bind(AGENT_UNIT, agents[0].tex);
        gl.drawArrays(gl.TRIANGLES, 0, numAgents * 6);
      }

      const numSpecies = Math.min(settings.species.length, MAX_SPECIES);
      colours.fill(0);
      for (let i = 0; i < numSpecies; i++) {
        const c = settings.species[i].colour;
        colours[i * 3] = c[0];
        colours[i * 3 + 1] = c[1];
        colours[i * 3 + 2] = c[2];
      }
      // Trail view: one opaque pass. Agents-only: walls and food blended over the points.
      gl.useProgram(renderProg.prog);
      gl.uniform1i(renderProg.u('uNumSpecies'), numSpecies);
      gl.uniform3fv(renderProg.u('uColours'), colours);
      gl.uniform2i(renderProg.u('uSize'), width, height);
      gl.uniform2f(renderProg.u('uCanvas'), cw, ch);
      gl.uniform3f(renderProg.u('uView'), zoom, view.cx, view.cy);
      gl.uniform2fv(renderProg.u('uFood'), foodPos);
      gl.uniform1i(renderProg.u('uFoodCount'), foodCount);
      gl.uniform1i(renderProg.u('uOverlay'), overlay ? 1 : 0);
      bind(TRAIL_UNIT, trail[0].tex);
      bind(WALL_UNIT, walls!.tex);
      if (overlay) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        // Discarded fragments (none in the opaque pass in practice) must not show stale pixels.
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      fullscreen();
      gl.disable(gl.BLEND);
    },

    clearTrail() {
      if (!trail.length || lost) return;
      clearTargets(trail);
    },

    clearWalls() {
      if (!walls || lost) return;
      clearTargets([walls]);
    },

    spawnAt(x: number, y: number, radius: number, count: number, settings: SimSettings) {
      if (!agents.length || lost || numAgents === 0) return;
      const n = Math.min(Math.floor(count), numAgents);
      if (n <= 0) return;
      const numSpecies = Math.max(1, Math.min(settings.species.length, MAX_SPECIES));
      if (spawnScratch.length < n * 4) spawnScratch = new Float32Array(n * 4);
      const data = spawnScratch.subarray(0, n * 4);
      for (let i = 0; i < n; i++) {
        const r = radius * Math.sqrt(Math.random());
        const a = Math.random() * Math.PI * 2;
        data[i * 4] = Math.min(width - 1, Math.max(0, x + Math.cos(a) * r));
        data[i * 4 + 1] = Math.min(height - 1, Math.max(0, y + Math.sin(a) * r));
        data[i * 4 + 2] = Math.random() * Math.PI * 2;
        data[i * 4 + 3] = Math.floor(Math.random() * numSpecies);
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      bind(AGENT_UNIT, agents[0].tex);
      // Ring cursor: split at the wrap into at most two contiguous ranges.
      const first = Math.min(n, numAgents - spawnCursor);
      uploadAgents(spawnCursor, data.subarray(0, first * 4));
      if (n > first) uploadAgents(0, data.subarray(first * 4));
      spawnCursor = (spawnCursor + n) % numAgents;
    },

    destroy() {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      release();
      lastInit = null;
      for (const p of [agentsProg, depositProg, diffuseProg, renderProg, agentsOnlyProg, wallEditProg]) {
        gl.deleteProgram(p.prog);
      }
      gl.deleteVertexArray(vao);
    },
  };
}
