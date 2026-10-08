#version 300 es
precision highp float;
in vec4 vAmount;
out vec4 outColour;
void main() {
  outColour = vAmount;
}
