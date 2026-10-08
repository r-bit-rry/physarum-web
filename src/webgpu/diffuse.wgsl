// Port of the Diffuse kernel: 3x3 blur from a shared 10x10 tile, decay, plus food, brush
// paint/erase and walls (wall cells hold 0 and count as 0 in their neighbours' blur).

@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read> walls: array<u32>;

var<workgroup> tile: array<vec4f, 100>;

@compute @workgroup_size(8, 8)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(local_invocation_index) li: u32,
) {
  let origin = vec2i(wid.xy * 8u) - 1;
  for (var t = li; t < 100u; t += 64u) {
    let i = cellIndex(origin.x + i32(t % 10u), origin.y + i32(t / 10u));
    tile[t] = select(src[i], vec4f(0.0), isWall(i));
  }
  workgroupBarrier();

  if (gid.x >= P.width || gid.y >= P.height) { return; }
  let idx = gid.y * P.width + gid.x;
  if (isWall(idx)) {
    dst[idx] = vec4f(0.0);
    return;
  }

  var sum = vec4f(0.0);
  for (var oy = 0u; oy < 3u; oy++) {
    for (var ox = 0u; ox < 3u; ox++) {
      sum += tile[(lid.y + oy) * 10u + lid.x + ox];
    }
  }
  let original = tile[(lid.y + 1u) * 10u + lid.x + 1u];
  let blurred = mix(original, sum / 9.0, saturate(P.diffuseRate * P.dt));
  let jones = P.jonesMode != 0u;

  var out: vec4f;
  if (jones) {
    out = max(vec4f(0.0), blurred * (1.0 - P.decayRate * P.dt));
  } else {
    out = max(vec4f(0.0), blurred - P.decayRate * P.dt);
  }

  let p = vec2f(gid.xy) + 0.5;
  let channels = vec4f(vec4u(0u, 1u, 2u, 3u) < vec4u(P.numSpecies));

  // Food sources emit into every active species channel
  var food = 0.0;
  for (var i = 0u; i < P.foodCount; i++) {
    let d = distance(p, foodPos(i));
    if (d <= FOOD_RADIUS) { food += 1.0 - d / FOOD_RADIUS; }
  }
  out += channels * P.foodStrength * P.dt * food;

  // Brush paint (3) / erase (4)
  if (P.brushAction == 3u || P.brushAction == 4u) {
    let f = brushFalloff(p);
    if (f > 0.0) {
      if (P.brushAction == 3u) {
        out += channels * P.brushStrength * P.dt * 2.0 * f;
      } else {
        out *= 1.0 - min(1.0, P.brushStrength * P.dt * 2.0 * f);
      }
    }
  }

  // Seb's trail never exceeds 1 (the deposit clamps; WebGL2 clamps on read).
  dst[idx] = select(min(out, vec4f(1.0)), out, jones);
}
