#version 300 es
// Port of the Diffuse kernel. Also applies Seb's min(1) deposit clamp (the deposit itself is
// an unclamped additive blend), brush paint/erase, food sources and walls. In jonesMode values are capped at uCeil
// (finite on the RGBA16F path, so Inf and Inf - Inf = NaN can't appear).
precision highp float;
precision highp int;

uniform highp sampler2D uTrail;
uniform highp sampler2D uWalls; // R8 mask, 1 = wall
uniform ivec2 uSize;
uniform bool uJones;
uniform float uDiffuseWeight; // saturate(diffuseRate * dt)
uniform float uDecay; // decayRate * dt
uniform int uNumSpecies;
uniform int uBrushAction; // 3 paint, 4 erase (others handled elsewhere)
uniform vec4 uBrush; // x, y, radius, strength * dt * 2
uniform vec2 uFood[16];
uniform int uFoodCount;
uniform float uFoodAmount; // foodStrength * dt
uniform float uCeil; // jonesMode cap: 60000 on RGBA16F, f32 max on RGBA32F
uniform bool uDither; // stochastic rounding for RGBA16F storage
uniform uint uSeed;

out vec4 outTrail;

uint hash(uint state) {
  state ^= 2747636419u;
  state *= 2654435769u;
  state ^= state >> 16;
  state *= 2654435769u;
  state ^= state >> 16;
  state *= 2654435769u;
  return state;
}

// Toroidal wrap without % on negative operands (undefined in GLSL ES 3.00).
ivec2 wrap(ivec2 p) {
  p -= uSize * ivec2(floor(vec2(p) / vec2(uSize)));
  p += uSize * ivec2(lessThan(p, ivec2(0)));
  return p - uSize * ivec2(greaterThanEqual(p, uSize));
}

vec4 fetch(ivec2 p) {
  p = uJones ? wrap(p) : clamp(p, ivec2(0), uSize - 1);
  // Walls count as 0 even if they still hold trail (first substep after a wall edit).
  if (texelFetch(uWalls, p, 0).r > 0.5) return vec4(0.0);
  vec4 v = texelFetch(uTrail, p, 0);
  return min(v, vec4(uJones ? uCeil : 1.0));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (texelFetch(uWalls, p, 0).r > 0.5) {
    outTrail = vec4(0.0);
    return;
  }
  vec4 original = fetch(p);
  vec4 sum = vec4(0.0);
  for (int ox = -1; ox <= 1; ox++) {
    for (int oy = -1; oy <= 1; oy++) {
      sum += fetch(p + ivec2(ox, oy));
    }
  }
  vec4 blurred = mix(original, sum / 9.0, uDiffuseWeight);
  vec4 result = uJones ? max(vec4(0.0), blurred * (1.0 - uDecay)) : max(vec4(0.0), blurred - uDecay);

  vec4 speciesMask = vec4(lessThan(ivec4(0, 1, 2, 3), ivec4(uNumSpecies)));
  for (int i = 0; i < 16; i++) {
    if (i >= uFoodCount) break;
    float d = distance(gl_FragCoord.xy, uFood[i]);
    if (d < 6.0) result += speciesMask * uFoodAmount * (1.0 - d / 6.0);
  }

  if (uBrushAction == 3 || uBrushAction == 4) {
    float dist = distance(gl_FragCoord.xy, uBrush.xy);
    if (dist < uBrush.z) {
      float falloff = 1.0 - smoothstep(0.0, uBrush.z, dist);
      if (uBrushAction == 3) {
        result += speciesMask * uBrush.w * falloff;
      } else {
        result *= 1.0 - min(1.0, uBrush.w * falloff);
      }
    }
  }
  result = min(result, vec4(uCeil));

  if (uDither) {
    // Add up to +-half an fp16 ulp of noise so the store rounds stochastically. Otherwise small
    // decays (e.g. 1 - 0.0002) round back to the same half-float and the trail never fades.
    uint h = hash(uint(p.y * uSize.x + p.x) ^ uSeed);
    vec4 r = vec4(uvec4(h, hash(h), hash(h + 1u), hash(h + 2u)) >> 8) / 16777216.0 - 0.5;
    vec4 ulp = exp2(floor(log2(max(result, vec4(6.1e-5)))) - 10.0);
    result = max(vec4(0.0), result + r * ulp * vec4(greaterThan(result, vec4(0.0))));
  }
  outTrail = result;
}
