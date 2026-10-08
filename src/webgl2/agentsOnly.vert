#version 300 es
// Port of DrawAgentMap.compute: one quad (6 vertices) per agent covering its cell [c, c+1),
// through the view transform. Quads rather than points: GLES may cull a whole point sprite
// whose centre is off-screen, which would blank partly-visible cells at the edges when zoomed.
uniform highp sampler2D uAgents;
uniform int uSide;
uniform ivec2 uSize;
uniform vec2 uCanvas;
uniform vec3 uView; // zoom, cx, cy

const vec2 CORNERS[6] = vec2[6](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1));

void main() {
  int id = gl_VertexID / 6;
  vec4 agent = texelFetch(uAgents, ivec2(id % uSide, id / uSide), 0);
  ivec2 c = clamp(ivec2(agent.xy), ivec2(0), uSize - 1);
  vec2 screen = (vec2(c) + CORNERS[gl_VertexID % 6] - uView.yz) * uView.x + uCanvas * 0.5;
  gl_Position = vec4(screen / uCanvas * 2.0 - 1.0, 0.0, 1.0);
}
