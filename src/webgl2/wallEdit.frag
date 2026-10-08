#version 300 es
// Writes the wall mask inside the brush disc. Drawn with a scissor over the brush bounding box.
precision highp float;

uniform vec3 uBrush; // x, y, radius
uniform float uValue; // 1 wall, 0 unwall

out vec4 outMask;

void main() {
  if (distance(gl_FragCoord.xy, uBrush.xy) > uBrush.z) discard;
  outMask = vec4(uValue);
}
