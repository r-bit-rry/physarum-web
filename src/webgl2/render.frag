#version 300 es
// Port of UpdateColourMap plus the view transform, walls and food rings. GL's window origin is
// bottom-left, which already matches sim y-up, so canvas -> sim is (frag - canvas / 2) / zoom + centre.
// uOverlay draws only walls and food (alpha blended), over the agents-only point view.
precision highp float;
precision highp int;

uniform highp sampler2D uTrail;
uniform highp sampler2D uWalls;
uniform ivec2 uSize;
uniform vec2 uCanvas;
uniform vec3 uView; // zoom, cx, cy
uniform int uNumSpecies;
uniform vec3 uColours[4];
uniform vec2 uFood[16];
uniform int uFoodCount;
uniform bool uOverlay;

out vec4 outColour;

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 sim = (frag - uCanvas * 0.5) / uView.x + uView.yz;
  vec4 colour = vec4(0.0, 0.0, 0.0, uOverlay ? 0.0 : 1.0);
  if (all(greaterThanEqual(sim, vec2(0.0))) && all(lessThan(sim, vec2(uSize)))) {
    ivec2 c = ivec2(floor(sim));
    if (texelFetch(uWalls, c, 0).r > 0.5) {
      colour = vec4(0.18, 0.18, 0.2, 1.0);
    } else if (!uOverlay) {
      vec4 trail = texelFetch(uTrail, c, 0);
      for (int i = 0; i < 4; i++) {
        if (i < uNumSpecies) colour.rgb += uColours[i] * trail[i];
      }
    }
  }
  // Food rings: radius 8 canvas px, 1.5 px thick, regardless of zoom.
  for (int i = 0; i < 16; i++) {
    if (i >= uFoodCount) break;
    vec2 s = (uFood[i] - uView.yz) * uView.x + uCanvas * 0.5;
    if (abs(distance(frag, s) - 8.0) <= 0.75) {
      colour.rgb = colour.a > 0.0 ? mix(colour.rgb, vec3(1.0), 0.9) : vec3(1.0);
      colour.a = max(colour.a, 0.9);
    }
  }
  if (colour.a == 0.0) discard;
  outColour = colour;
}
