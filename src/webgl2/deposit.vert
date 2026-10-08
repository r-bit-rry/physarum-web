#version 300 es
// One point per agent, additively blended into the trail map.
uniform highp sampler2D uAgents;
uniform int uSide;
uniform ivec2 uSize;
uniform int uNumSpecies;
uniform float uAmount; // trailWeight * dt

out vec4 vAmount;

void main() {
  vec4 agent = texelFetch(uAgents, ivec2(gl_VertexID % uSide, gl_VertexID / uSide), 0);
  int species = int(agent.w);
  gl_PointSize = 1.0;
  vAmount = vec4(0.0);
  if (species >= 4) {
    // Clamped at the edge or blocked by a wall this step: cull outside the clip volume.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  ivec2 c = clamp(ivec2(agent.xy), ivec2(0), uSize - 1);
  gl_Position = vec4((vec2(c) + 0.5) / vec2(uSize) * 2.0 - 1.0, 0.0, 1.0);
  vec4 mask = uNumSpecies == 1 ? vec4(1.0) : vec4(equal(ivec4(species), ivec4(0, 1, 2, 3)));
  vAmount = mask * uAmount;
}
