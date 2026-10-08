import { Backend } from '../backend';
import { BrushAction, InputState, MAX_FOOD, MAX_SPECIES, SimSettings, View } from '../config';
import commonSrc from './common.wgsl?raw';
import agentsSrc from './agents.wgsl?raw';
import diffuseSrc from './diffuse.wgsl?raw';
import renderSrc from './render.wgsl?raw';
import wallsSrc from './walls.wgsl?raw';

const AGENT_CAP = 16_000_000;
const AGENT_WG = 64;
const MAX_WG_PER_DIM = 65535;
/** Bytes; must match struct Params in common.wgsl (96 B globals + 8 x 16 B food + 4 x 32 B species). */
const FOOD_OFFSET = 24; // in 4-byte words
const SPECIES_OFFSET = FOOD_OFFSET + MAX_FOOD * 2;
const UNIFORM_SIZE = SPECIES_OFFSET * 4 + MAX_SPECIES * 32;
const ACTIONS: Record<BrushAction, number> = { none: 0, attract: 1, repel: 2, paint: 3, erase: 4, wall: 5, unwall: 6 };

export async function createWebGPUBackend(canvas: HTMLCanvasElement): Promise<Backend> {
  // Fail before touching the canvas so the WebGL2 fallback can still get a context.
  if (!navigator.gpu) throw new Error('navigator.gpu is missing');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');

  const lim = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
      maxBufferSize: lim.maxBufferSize,
    },
  });
  device.lost.then((info) => {
    console.error(`WebGPU device lost (${info.reason}): ${info.message}`);
    if (info.reason === 'destroyed') return;
    // The canvas is bound to a 'webgpu' context, so no in-place fallback; surface it in the page's error overlay.
    const el = document.getElementById('error');
    if (!el) return;
    el.textContent = `WebGPU device lost: ${info.message || 'unknown reason'}. Reload the page (or use ?backend=webgl2).`;
    el.style.display = 'flex';
  });
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU error:', e.error.message));

  const maxBinding = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  const maxAgents = Math.min(AGENT_CAP, Math.floor(maxBinding / 16));

  const module = async (src: string, label: string) => {
    const m = device.createShaderModule({ label, code: commonSrc + '\n' + src });
    const info = await m.getCompilationInfo();
    for (const msg of info.messages) {
      if (msg.type === 'error') console.error(`${label}:${msg.lineNum}:${msg.linePos} ${msg.message}`);
    }
    return m;
  };
  const [agentsMod, diffuseMod, renderMod, wallsMod] = await Promise.all([
    module(agentsSrc, 'agents.wgsl'),
    module(diffuseSrc, 'diffuse.wgsl'),
    module(renderSrc, 'render.wgsl'),
    module(wallsSrc, 'walls.wgsl'),
  ]);

  const format = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas.getContext('webgpu');
  if (!ctx) throw new Error('canvas.getContext("webgpu") failed');
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const [agentsPipe, diffusePipe, wallsPipe, trailPipe, pointPipe, overlayPipe] = await Promise.all([
    device.createComputePipelineAsync({ layout: 'auto', compute: { module: agentsMod, entryPoint: 'main' } }),
    device.createComputePipelineAsync({ layout: 'auto', compute: { module: diffuseMod, entryPoint: 'main' } }),
    device.createComputePipelineAsync({ layout: 'auto', compute: { module: wallsMod, entryPoint: 'main' } }),
    device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: renderMod, entryPoint: 'vsFull' },
      fragment: { module: renderMod, entryPoint: 'fsTrail', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    }),
    device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: renderMod, entryPoint: 'vsAgent' },
      fragment: { module: renderMod, entryPoint: 'fsAgent', targets: [{ format }] },
      primitive: { topology: 'point-list' },
    }),
    device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: renderMod, entryPoint: 'vsFull' },
      fragment: {
        module: renderMod,
        entryPoint: 'fsOverlay',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    }),
  ]);

  const uniformBuf = device.createBuffer({ size: UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uData = new ArrayBuffer(UNIFORM_SIZE);
  const u32 = new Uint32Array(uData);
  const f32 = new Float32Array(uData);
  const i32 = new Int32Array(uData);
  let lastTime = 0;
  let threadsPerRow = 0;
  // Agent count the buffers/dispatch were sized for; the GUI slider changes settings.numAgents before reset.
  let agentCount = 0;

  // Brush and food persist in uData between writes; render() only updates settings, view and food.
  const writeUniforms = (s: SimSettings, time: number, dt: number) => {
    const n = Math.min(s.species.length, MAX_SPECIES);
    u32[0] = s.width;
    u32[1] = s.height;
    u32[2] = agentCount;
    u32[3] = n;
    f32[4] = s.trailWeight;
    f32[5] = s.decayRate;
    f32[6] = s.diffuseRate;
    f32[7] = dt;
    u32[8] = Math.floor(time * 100000) >>> 0;
    u32[9] = s.jonesMode ? 1 : 0;
    u32[11] = threadsPerRow;
    for (let i = 0; i < n; i++) {
      const sp = s.species[i];
      const o = SPECIES_OFFSET + i * 8;
      f32[o] = sp.moveSpeed;
      f32[o + 1] = sp.turnSpeed;
      f32[o + 2] = sp.sensorAngleSpacing * (3.1415 / 180); // Seb's constant
      f32[o + 3] = sp.sensorOffsetDst;
      f32.set(sp.colour, o + 4);
      i32[o + 7] = Math.round(sp.sensorSize);
    }
    device.queue.writeBuffer(uniformBuf, 0, uData);
  };

  const setFood = (food: { x: number; y: number }[]) => {
    const n = Math.min(food.length, MAX_FOOD);
    u32[16] = n;
    for (let i = 0; i < n; i++) {
      f32[FOOD_OFFSET + i * 2] = food[i].x;
      f32[FOOD_OFFSET + i * 2 + 1] = food[i].y;
    }
  };

  const setInput = (input: InputState) => {
    const b = input.brush;
    u32[10] = ACTIONS[b.action] ?? 0;
    f32[12] = b.x;
    f32[13] = b.y;
    f32[14] = b.radius;
    f32[15] = b.strength;
    f32[17] = input.foodStrength;
    setFood(input.food);
  };

  const setView = (view: View) => {
    f32[18] = view.zoom;
    f32[20] = view.cx;
    f32[21] = view.cy;
  };
  setView({ zoom: 1, cx: 0, cy: 0 });

  let agentBuf: GPUBuffer | undefined;
  let trailBufs: GPUBuffer[] = [];
  let wallBuf: GPUBuffer | undefined;
  let wallGroup: GPUBindGroup | undefined;
  let overlayGroup: GPUBindGroup | undefined;
  // Next agent slot spawnAt() overwrites (ring buffer, oldest first).
  let spawnCursor = 0;
  let mapSize = { width: 1, height: 1 };
  let agentGroups: GPUBindGroup[] = [];
  let diffuseGroups: GPUBindGroup[] = [];
  let trailGroups: GPUBindGroup[] = [];
  let pointGroup: GPUBindGroup | undefined;
  let cur = 0;
  let dims = { agentX: 1, agentY: 1, diffX: 1, diffY: 1 };

  const freeBuffers = () => {
    agentBuf?.destroy();
    trailBufs.forEach((b) => b.destroy());
    wallBuf?.destroy();
    agentBuf = undefined;
    trailBufs = [];
    wallBuf = undefined;
  };

  const group = (pipe: GPUComputePipeline | GPURenderPipeline, bufs: GPUBuffer[], bindings: number[]) =>
    device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        ...bufs.map((buffer, i) => ({ binding: bindings[i], resource: { buffer } })),
      ],
    });

  return {
    name: 'webgpu',
    maxAgents,

    init(settings, agents) {
      freeBuffers();
      const { width, height } = settings;
      const n = Math.min(settings.numAgents, maxAgents);
      settings.numAgents = n;
      agentCount = n;

      agentBuf = device.createBuffer({
        size: Math.max(16, n * 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(agentBuf, 0, agents as Float32Array<ArrayBuffer>, 0, n * 4);
      // New buffers are zero-initialised, which clears the trail and walls.
      trailBufs = [0, 1].map(() =>
        device.createBuffer({ size: width * height * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      );
      wallBuf = device.createBuffer({ size: width * height * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      cur = 0;
      spawnCursor = 0;
      u32[19] = 0; // hasWalls
      mapSize = { width, height };

      const groups = Math.max(1, Math.ceil(n / AGENT_WG));
      const agentX = Math.min(groups, MAX_WG_PER_DIM);
      threadsPerRow = agentX * AGENT_WG;
      dims = { agentX, agentY: Math.ceil(groups / agentX), diffX: Math.ceil(width / 8), diffY: Math.ceil(height / 8) };

      const wb = wallBuf;
      agentGroups = trailBufs.map((t) => group(agentsPipe, [agentBuf!, t, wb], [1, 2, 3]));
      diffuseGroups = [0, 1].map((i) => group(diffusePipe, [trailBufs[i], trailBufs[1 - i], wb], [1, 2, 3]));
      trailGroups = trailBufs.map((t) => group(trailPipe, [t, wb], [1, 3]));
      pointGroup = group(pointPipe, [agentBuf], [2]);
      wallGroup = group(wallsPipe, [wb], [1]);
      overlayGroup = group(overlayPipe, [wb], [3]);
    },

    step(params, steps) {
      if (!agentBuf || steps < 0 || (steps === 0 && params.input.brush.action !== 'wall' && params.input.brush.action !== 'unwall')) return;
      // One uniform write per call: time stays constant across substeps, like Unity's fixedTime.
      lastTime = params.time;
      setInput(params.input);
      const { brush } = params.input;
      const { width, height } = mapSize;
      // Wall edit bounding box (inclusive cells), clipped to the map.
      const x0 = Math.max(0, Math.floor(brush.x - brush.radius));
      const y0 = Math.max(0, Math.floor(brush.y - brush.radius));
      const x1 = Math.min(width - 1, Math.floor(brush.x + brush.radius));
      const y1 = Math.min(height - 1, Math.floor(brush.y + brush.radius));
      const editWalls = (brush.action === 'wall' || brush.action === 'unwall') && x1 >= x0 && y1 >= y0;
      // Shaders skip every wall read until the first wall is drawn (the mask costs ~20-50% bandwidth).
      if (editWalls && brush.action === 'wall') u32[19] = 1;
      i32[22] = x0;
      i32[23] = y0;
      writeUniforms(params.settings, params.time, params.dt);
      const enc = device.createCommandEncoder();
      // Each dispatch is its own usage scope, so storage writes are visible to the next dispatch.
      const pass = enc.beginComputePass();
      if (editWalls) {
        pass.setPipeline(wallsPipe);
        pass.setBindGroup(0, wallGroup!);
        pass.dispatchWorkgroups(Math.ceil((x1 - x0 + 1) / 8), Math.ceil((y1 - y0 + 1) / 8));
      }
      for (let i = 0; i < steps; i++) {
        pass.setPipeline(agentsPipe);
        pass.setBindGroup(0, agentGroups[cur]);
        pass.dispatchWorkgroups(dims.agentX, dims.agentY);
        pass.setPipeline(diffusePipe);
        pass.setBindGroup(0, diffuseGroups[cur]);
        pass.dispatchWorkgroups(dims.diffX, dims.diffY);
        cur = 1 - cur;
      }
      pass.end();
      device.queue.submit([enc.finish()]);
    },

    render(settings, view, food) {
      if (!agentBuf) return;
      // Colours/species count may have changed via the GUI; brush fields are left as last written.
      setView(view);
      setFood(food);
      writeUniforms(settings, lastTime, 0);
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      if (settings.showAgentsOnly) {
        pass.setPipeline(pointPipe);
        pass.setBindGroup(0, pointGroup!);
        pass.draw(agentCount);
        pass.setPipeline(overlayPipe);
        pass.setBindGroup(0, overlayGroup!);
        pass.draw(3);
      } else {
        pass.setPipeline(trailPipe);
        pass.setBindGroup(0, trailGroups[cur]);
        pass.draw(3);
      }
      pass.end();
      device.queue.submit([enc.finish()]);
    },

    clearTrail() {
      if (!trailBufs.length) return;
      const enc = device.createCommandEncoder();
      trailBufs.forEach((b) => enc.clearBuffer(b));
      device.queue.submit([enc.finish()]);
    },

    clearWalls() {
      if (!wallBuf) return;
      const enc = device.createCommandEncoder();
      enc.clearBuffer(wallBuf);
      u32[19] = 0;
      device.queue.submit([enc.finish()]);
    },

    spawnAt(x, y, radius, count, settings) {
      if (!agentBuf || agentCount === 0) return;
      count = Math.min(Math.floor(count), agentCount);
      if (count <= 0) return;
      const { width, height } = mapSize;
      const numSpecies = Math.max(1, Math.min(settings.species.length, MAX_SPECIES));
      const data = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        // Uniform in the disc, clamped into the map like the edge rule.
        const r = radius * Math.sqrt(Math.random());
        const t = Math.random() * Math.PI * 2;
        data[i * 4] = Math.min(width - 1, Math.max(0, x + r * Math.cos(t)));
        data[i * 4 + 1] = Math.min(height - 1, Math.max(0, y + r * Math.sin(t)));
        data[i * 4 + 2] = Math.random() * Math.PI * 2;
        data[i * 4 + 3] = Math.floor(Math.random() * numSpecies);
      }
      // One contiguous range, or two if the ring wraps.
      const first = Math.min(count, agentCount - spawnCursor);
      device.queue.writeBuffer(agentBuf, spawnCursor * 16, data, 0, first * 4);
      if (count > first) device.queue.writeBuffer(agentBuf, 0, data, first * 4, (count - first) * 4);
      spawnCursor = (spawnCursor + count) % agentCount;
    },

    destroy() {
      freeBuffers();
      uniformBuf.destroy();
      ctx.unconfigure();
      device.destroy();
    },
  };
}
