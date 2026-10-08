import { SimSettings, StepParams, View } from './config';

/**
 * A GPU implementation of the simulation. The canvas is sized to settings.width x settings.height
 * by main.ts before init(); CSS scales it to the viewport.
 *
 * Coordinate convention: sim y = 0 is the bottom row of the screen (Unity texture space),
 * so render() must flip vertically.
 */
export interface Backend {
  readonly name: 'webgpu' | 'webgl2';
  /** Largest agent count this backend/device can allocate. */
  readonly maxAgents: number;

  /**
   * (Re)allocate all GPU resources for these settings and upload agents
   * (packed x, y, angle, speciesIndex floats; see spawn.ts). Clears the trail map and walls.
   */
  init(settings: SimSettings, agents: Float32Array): void;

  /**
   * Run `steps` simulation steps (wall edit if the brush action is wall/unwall, then agents pass +
   * diffuse/decay pass each). Brush and food come from params.input. `steps` may be 0 to only
   * apply the wall edit (main.ts uses this to fill in fast strokes and to edit while paused).
   */
  step(params: StepParams, steps: number): void;

  /**
   * Draw the trail map (or agents if settings.showAgentsOnly), walls and food markers to the canvas.
   * Canvas pixel p maps to sim coordinate (p - canvasSize / 2) / view.zoom + (view.cx, view.cy),
   * with canvas y flipped so sim y = 0 is at the bottom. Pixels outside the map are black.
   */
  render(settings: SimSettings, view: View, food: { x: number; y: number }[]): void;

  clearTrail(): void;
  clearWalls(): void;

  /**
   * Overwrite `count` agents, chosen round-robin from a ring cursor (oldest first), with random
   * positions in the disc (x, y, radius), random headings, and random species in [0, numSpecies).
   */
  spawnAt(x: number, y: number, radius: number, count: number, settings: SimSettings): void;

  destroy(): void;
}
