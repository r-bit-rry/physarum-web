#version 300 es
// Port of the Update kernel in SlimeSim.compute. One fragment per agent texel.
// Output w = speciesIndex, +4 if the agent was clamped at the edge or blocked by a wall this step
// (it must not deposit).
precision highp float;
precision highp int;

uniform highp sampler2D uAgents;
uniform highp sampler2D uTrail;
uniform highp sampler2D uWalls; // R8 mask, 1 = wall
uniform ivec2 uSize;
uniform int uSide;
uniform int uNumAgents;
uniform int uNumSpecies;
uniform uint uTimeSeed; // u32(time * 100000), wrapped in JS
uniform float uDt;
uniform bool uJones;
uniform vec4 uSpecies[4]; // moveSpeed, turnSpeed, sensorAngleDegrees, sensorOffsetDst
uniform int uSensorSize[4];
uniform int uBrushAction; // 1 attract, 2 repel (others handled elsewhere)
uniform vec4 uBrush; // x, y, radius, min(1, strength * dt * 5)

out vec4 outAgent;

// Schechter & Bridson hash, as in SlimeSim.compute.
uint hash(uint state) {
  state ^= 2747636419u;
  state *= 2654435769u;
  state ^= state >> 16;
  state *= 2654435769u;
  state ^= state >> 16;
  state *= 2654435769u;
  return state;
}

float scaleToRange01(uint state) {
  return float(state) / 4294967295.0;
}

// Toroidal wrap without % on negative operands (undefined in GLSL ES 3.00).
ivec2 wrap(ivec2 p) {
  p -= uSize * ivec2(floor(vec2(p) / vec2(uSize)));
  p += uSize * ivec2(lessThan(p, ivec2(0)));
  return p - uSize * ivec2(greaterThanEqual(p, uSize));
}

ivec2 address(ivec2 p) {
  return uJones ? wrap(p) : clamp(p, ivec2(0), uSize - 1);
}

float sense(vec2 pos, float angle, vec4 weight, float offsetDst, int n) {
  vec2 sensorPos = pos + vec2(cos(angle), sin(angle)) * offsetDst;
  // HLSL (int) truncates; floor in wrap mode so negative coords wrap correctly.
  ivec2 c = uJones ? ivec2(floor(sensorPos)) : ivec2(sensorPos);
  float sum = 0.0;
  for (int ox = -n; ox <= n; ox++) {
    for (int oy = -n; oy <= n; oy++) {
      ivec2 a = address(c + ivec2(ox, oy));
      // Walls repel strongly so agents steer around them.
      sum += texelFetch(uWalls, a, 0).r > 0.5 ? -10.0 : dot(weight, texelFetch(uTrail, a, 0));
    }
  }
  return sum;
}

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int id = tc.y * uSide + tc.x;
  vec4 agent = texelFetch(uAgents, tc, 0);
  if (id >= uNumAgents) {
    outAgent = agent;
    return;
  }

  int species = int(agent.w) & 3;
  vec2 pos = agent.xy;
  float angle = agent.z;
  vec4 s = uSpecies[species];
  vec4 mask = uNumSpecies == 1 ? vec4(1.0) : vec4(equal(ivec4(species), ivec4(0, 1, 2, 3)));
  vec4 weight = mask * 2.0 - 1.0;
  vec2 size = vec2(uSize);

  uint random = hash(uint(pos.y * size.x + pos.x) + hash(uint(id) + uTimeSeed));

  // Steer based on sensory data
  float sensorAngleRad = s.z * (3.1415 / 180.0);
  float wF = sense(pos, angle, weight, s.w, uSensorSize[species]);
  float wL = sense(pos, angle + sensorAngleRad, weight, s.w, uSensorSize[species]);
  float wR = sense(pos, angle - sensorAngleRad, weight, s.w, uSensorSize[species]);

  float rnd = scaleToRange01(random);
  float turn = s.y * 2.0 * 3.1415 * uDt;
  float newAngle = angle;
  if (wF > wL && wF > wR) {
    // Continue in same direction
  } else if (wF < wL && wF < wR) {
    newAngle += uJones ? (rnd < 0.5 ? -turn : turn) : (rnd - 0.5) * 2.0 * turn;
  } else if (wR > wL) {
    newAngle -= uJones ? turn : rnd * turn;
  } else if (wL > wR) {
    newAngle += uJones ? turn : rnd * turn;
  }

  if (uBrushAction == 1 || uBrushAction == 2) {
    vec2 d = uBrush.xy - pos;
    float dist = length(d);
    if (dist < uBrush.z && dist > 0.0) {
      float falloff = 1.0 - smoothstep(0.0, uBrush.z, dist);
      float target = atan(d.y, d.x) + (uBrushAction == 2 ? 3.14159265 : 0.0);
      float diff = target - newAngle;
      newAngle += atan(sin(diff), cos(diff)) * uBrush.w * falloff;
    }
  }

  // Move using the pre-turn angle, as the HLSL does.
  vec2 newPos = pos + vec2(cos(angle), sin(angle)) * uDt * s.x;
  float noDeposit = 0.0;
  if (any(lessThan(newPos, vec2(0.0))) || any(greaterThanEqual(newPos, size))) {
    if (uJones) {
      newPos = mod(newPos, size);
    } else {
      random = hash(random);
      newAngle = scaleToRange01(random) * 2.0 * 3.1415;
      newPos = clamp(newPos, vec2(0.0), size - 1.0);
      noDeposit = 4.0;
    }
  }
  // Blocked by a wall: stay put and pick a new random heading, like the edge rule.
  if (texelFetch(uWalls, clamp(ivec2(newPos), ivec2(0), uSize - 1), 0).r > 0.5) {
    random = hash(random);
    newAngle = scaleToRange01(random) * 2.0 * 3.1415;
    newPos = pos;
    noDeposit = 4.0;
  }
  outAgent = vec4(newPos, newAngle, float(species) + noDeposit);
}
