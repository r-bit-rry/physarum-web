// Colour map (UpdateColourMap) as a full-screen triangle through the view transform, plus the
// showAgentsOnly point pass and a blended wall/food overlay for it.

@group(0) @binding(1) var<storage, read> trail: array<vec4f>;
@group(0) @binding(3) var<storage, read> walls: array<u32>;

const WALL_COLOUR = vec3f(0.18, 0.18, 0.2);
const RING_RADIUS = 8.0; // canvas px
const RING_HALF_WIDTH = 0.75;

fn canvasSize() -> vec2f {
  return vec2f(f32(P.width), f32(P.height));
}

/** Canvas pixel (y down) -> sim coordinate (y up). */
fn toSim(p: vec2f) -> vec2f {
  let half = canvasSize() * 0.5;
  return vec2f(p.x - half.x, half.y - p.y) / P.zoom + P.viewCentre;
}

/** Sim coordinate -> canvas pixel. */
fn toCanvas(s: vec2f) -> vec2f {
  let d = (s - P.viewCentre) * P.zoom;
  let half = canvasSize() * 0.5;
  return vec2f(half.x + d.x, half.y - d.y);
}

/** Map cell under canvas pixel p, or -1 outside the map. */
fn cellAt(p: vec2f) -> i32 {
  let s = floor(toSim(p));
  if (any(s < vec2f(0.0)) || any(s >= canvasSize())) { return -1; }
  return i32(s.y) * i32(P.width) + i32(s.x);
}

/** Food ring coverage (0..1) at canvas pixel p, anti-aliased over ~1 px. */
fn ringCoverage(p: vec2f) -> f32 {
  var cov = 0.0;
  for (var i = 0u; i < P.foodCount; i++) {
    let d = abs(distance(p, toCanvas(foodPos(i))) - RING_RADIUS);
    cov = max(cov, saturate(RING_HALF_WIDTH + 0.5 - d));
  }
  return cov;
}

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fsTrail(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let cell = cellAt(frag.xy);
  var colour = vec3f(0.0);
  if (cell >= 0) {
    if (isWall(u32(cell))) {
      colour = WALL_COLOUR;
    } else {
      let t = trail[cell];
      for (var i = 0u; i < P.numSpecies; i++) {
        colour += P.species[i].colour * t[i];
      }
    }
  }
  return vec4f(mix(colour, vec3f(1.0), 0.9 * ringCoverage(frag.xy)), 1.0);
}

/** Walls and food rings over the agent points; alpha-blended. */
@fragment
fn fsOverlay(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let cell = cellAt(frag.xy);
  let a = 0.9 * ringCoverage(frag.xy);
  if (cell >= 0 && isWall(u32(cell))) { return vec4f(mix(WALL_COLOUR, vec3f(1.0), a), 1.0); }
  return vec4f(1.0, 1.0, 1.0, a);
}

@group(0) @binding(2) var<storage, read> agents: array<vec4f>;

@vertex
fn vsAgent(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = toCanvas(floor(agents[vi].xy) + 0.5);
  let ndc = p / canvasSize() * 2.0 - 1.0;
  return vec4f(ndc.x, -ndc.y, 0.0, 1.0);
}

@fragment
fn fsAgent() -> @location(0) vec4f {
  return vec4f(1.0);
}
