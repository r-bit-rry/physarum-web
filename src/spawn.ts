import { SimSettings, SpawnMode } from './config';

/** Floats per agent in the packed buffer: x, y, angle, speciesIndex. */
export const AGENT_STRIDE = 4;

// Port of Simulation.Init(). Species index is stored as a float so the same
// Float32Array can be uploaded to a WebGPU storage buffer or a WebGL RGBA32F texture.
export function spawnAgents(settings: SimSettings): Float32Array {
  const { width, height, numAgents, spawnMode } = settings;
  const numSpecies = settings.species.length;
  const data = new Float32Array(numAgents * AGENT_STRIDE);
  const cx = width / 2;
  const cy = height / 2;

  for (let i = 0; i < numAgents; i++) {
    const randomAngle = Math.random() * Math.PI * 2;
    let x = 0;
    let y = 0;
    let angle = 0;

    switch (spawnMode) {
      case SpawnMode.Point:
        x = cx;
        y = cy;
        angle = randomAngle;
        break;
      case SpawnMode.Random:
        x = Math.random() * width;
        y = Math.random() * height;
        angle = randomAngle;
        break;
      case SpawnMode.InwardCircle: {
        [x, y] = insideUnitCircle(height * 0.5);
        x += cx;
        y += cy;
        angle = Math.atan2(cy - y, cx - x);
        break;
      }
      case SpawnMode.RandomCircle: {
        [x, y] = insideUnitCircle(height * 0.15);
        x += cx;
        y += cy;
        angle = randomAngle;
        break;
      }
    }

    const o = i * AGENT_STRIDE;
    data[o] = x;
    data[o + 1] = y;
    data[o + 2] = angle;
    data[o + 3] = numSpecies === 1 ? 0 : Math.floor(Math.random() * numSpecies);
  }
  return data;
}

function insideUnitCircle(scale: number): [number, number] {
  const r = Math.sqrt(Math.random()) * scale;
  const t = Math.random() * Math.PI * 2;
  return [Math.cos(t) * r, Math.sin(t) * r];
}
