// Wall edit: write 1 (wall, action 5) or 0 (unwall, action 6) inside the brush disc.
// Dispatched over the brush bounding box, starting at P.wallOrigin.

@group(0) @binding(1) var<storage, read_write> walls: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let c = P.wallOrigin + vec2i(gid.xy);
  if (c.x < 0 || c.y < 0 || c.x >= i32(P.width) || c.y >= i32(P.height)) { return; }
  if (distance(vec2f(c) + 0.5, P.brush) > P.brushRadius) { return; }
  walls[u32(c.y) * P.width + u32(c.x)] = select(0u, 1u, P.brushAction == 5u);
}
