// Mirrors Assets/Scripts/Slime/SlimeSettings.cs and the presets in Assets/Settings/*.asset.

export enum SpawnMode {
  Random = 0,
  Point = 1,
  InwardCircle = 2,
  RandomCircle = 3,
}

export const MAX_SPECIES = 4;

/** Unity's default Time.fixedDeltaTime; Simulation.cs runs in FixedUpdate. */
export const FIXED_DT = 0.02;

export interface SpeciesSettings {
  moveSpeed: number;
  /** Revolutions per second (shader multiplies by 2π). Negative values are valid and used by presets. */
  turnSpeed: number;
  /** Degrees. */
  sensorAngleSpacing: number;
  sensorOffsetDst: number;
  /** Sensor samples a (2n+1)² block. */
  sensorSize: number;
  /** Linear RGB, 0..1. */
  colour: [number, number, number];
}

export interface SimSettings {
  stepsPerFrame: number;
  width: number;
  height: number;
  numAgents: number;
  spawnMode: SpawnMode;
  trailWeight: number;
  decayRate: number;
  diffuseRate: number;
  species: SpeciesSettings[];
  /** Display only agent positions instead of the trail map. */
  showAgentsOnly: boolean;
  /**
   * Behave closer to Jones (2010): fixed ±turn instead of a random fraction, multiplicative decay,
   * toroidal wrap instead of edge clamping, and no clamp of the trail at 1.
   */
  jonesMode: boolean;
}

export const MAX_FOOD = 16;

/** What the brush does this step. Gesture -> action mapping lives in input.ts. */
export type BrushAction = 'none' | 'attract' | 'repel' | 'paint' | 'erase' | 'wall' | 'unwall';

export interface Brush {
  /** Sim pixel coordinates; y = 0 is the bottom row (matches Unity texture space). */
  x: number;
  y: number;
  /** Sim pixels. */
  radius: number;
  strength: number;
  action: BrushAction;
}

export interface InputState {
  brush: Brush;
  /** Persistent food sources (sim coords), at most MAX_FOOD. Each emits trail into every active species channel. */
  food: { x: number; y: number }[];
  /** Trail added per second inside a food source. */
  foodStrength: number;
}

/** Display transform: `zoom` >= 1, (cx, cy) is the sim-space point shown at the canvas centre. */
export interface View {
  zoom: number;
  cx: number;
  cy: number;
}

export interface StepParams {
  settings: SimSettings;
  /** Unity Time.fixedTime equivalent, seconds. Used to seed the per-agent hash. */
  time: number;
  /** Always FIXED_DT; passed explicitly so backends never read globals. */
  dt: number;
  input: InputState;
}

const sp = (
  moveSpeed: number,
  turnSpeed: number,
  sensorAngleSpacing: number,
  sensorOffsetDst: number,
  sensorSize: number,
  colour: [number, number, number],
): SpeciesSettings => ({ moveSpeed, turnSpeed, sensorAngleSpacing, sensorOffsetDst, sensorSize, colour });

const base = { stepsPerFrame: 2, width: 1920, height: 1080, showAgentsOnly: false, jonesMode: false };

export const PRESETS: Record<string, SimSettings> = {
  A: {
    ...base,
    numAgents: 250000,
    spawnMode: SpawnMode.InwardCircle,
    trailWeight: 5,
    decayRate: 0.2,
    diffuseRate: 3,
    species: [sp(20, 2, 30, 35, 1, [1, 1, 1])],
  },
  B: {
    ...base,
    numAgents: 25000,
    spawnMode: SpawnMode.InwardCircle,
    trailWeight: 8,
    decayRate: 0.5,
    diffuseRate: 3,
    species: [
      sp(50, 30, 45, 20, 1, [1, 0.06132078, 0.1610105]),
      sp(50, -90, 112, 30, 1, [0.47160125, 0.8301887, 0.105731584]),
    ],
  },
  C: {
    ...base,
    numAgents: 250000,
    spawnMode: SpawnMode.Point,
    trailWeight: 2,
    decayRate: 0.75,
    diffuseRate: 5,
    species: [sp(30, -3, 112, 20, 1, [0, 1, 0.31496096])],
  },
  D: {
    ...base,
    numAgents: 25000,
    spawnMode: SpawnMode.InwardCircle,
    trailWeight: 12,
    decayRate: 0.5,
    diffuseRate: 3,
    species: [
      sp(70, 30, 60, 20, 1, [0.53608304, 0.062745094, 1]),
      sp(50, -90, 112, 30, 1, [0.10588236, 0.6240185, 0.83137256]),
      sp(50, 50, 70, 30, 1, [0.47160125, 0.8301887, 0.105731584]),
    ],
  },
};

export function clonePreset(name: string): SimSettings {
  return structuredClone(PRESETS[name]);
}
