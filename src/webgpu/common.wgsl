// Shared uniforms and helpers. Layout must match writeUniforms() in gpuBackend.ts.

struct Species {
  moveSpeed: f32,
  turnSpeed: f32,
  sensorAngleRad: f32,
  sensorOffsetDst: f32,
  colour: vec3f,
  sensorSize: i32,
}

struct Params {
  width: u32,
  height: u32,
  numAgents: u32,
  numSpecies: u32,
  trailWeight: f32,
  decayRate: f32,
  diffuseRate: f32,
  dt: f32,
  /** u32(time * 100000) computed in JS doubles; wraps instead of saturating. */
  timeSeed: u32,
  jonesMode: u32,
  /** 0 none, 1 attract, 2 repel, 3 paint, 4 erase, 5 wall, 6 unwall. */
  brushAction: u32,
  /** Agent threads per dispatch row (2D dispatch for > 65535 workgroups). */
  threadsPerRow: u32,
  brush: vec2f,
  brushRadius: f32,
  brushStrength: f32,
  foodCount: u32,
  foodStrength: f32,
  zoom: f32,
  /** 0 until a wall is drawn (reset by init/clearWalls): lets every pass skip the mask reads. */
  hasWalls: u32,
  /** Sim-space point shown at the canvas centre. */
  viewCentre: vec2f,
  /** Bottom-left cell of the wall edit dispatch. */
  wallOrigin: vec2i,
  /** Two food points per vec4 (xy, zw); uniform arrays need a 16-byte stride. */
  food: array<vec4f, 8>,
  species: array<Species, 4>,
}

@group(0) @binding(0) var<uniform> P: Params;

const PI = 3.1415; // Seb's constant, kept for identical behaviour
const FOOD_RADIUS = 6.0;

// Hash function www.cs.ubc.ca/~rbridson/docs/schechter-sca08-turbulence.pdf
fn hash(s: u32) -> u32 {
  var state = s;
  state ^= 2747636419u;
  state *= 2654435769u;
  state ^= state >> 16u;
  state *= 2654435769u;
  state ^= state >> 16u;
  state *= 2654435769u;
  return state;
}

fn scaleToRange01(state: u32) -> f32 {
  return f32(state) / 4294967295.0;
}

fn wrapi(v: i32, n: i32) -> i32 {
  return ((v % n) + n) % n;
}

/** Clamped (Seb) or toroidal (Jones) cell index. */
fn cellIndex(x: i32, y: i32) -> u32 {
  let w = i32(P.width);
  let h = i32(P.height);
  if (P.jonesMode != 0u) {
    return u32(wrapi(y, h) * w + wrapi(x, w));
  }
  return u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1));
}

/** Smooth 1 -> 0 falloff over the brush radius. */
fn brushFalloff(p: vec2f) -> f32 {
  let d = distance(p, P.brush);
  return 1.0 - smoothstep(0.0, P.brushRadius, d);
}

/** Wall test; short-circuits so no mask read happens while the map has no walls. */
fn isWall(i: u32) -> bool {
  return P.hasWalls != 0u && walls[i] != 0u;
}

fn foodPos(i: u32) -> vec2f {
  let v = P.food[i / 2u];
  return select(v.xy, v.zw, (i & 1u) == 1u);
}
