// Port of the Update kernel in SlimeSim.compute.

@group(0) @binding(1) var<storage, read_write> agents: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> trail: array<vec4f>;
@group(0) @binding(3) var<storage, read> walls: array<u32>;

const WALL_SENSE = -10.0;

fn speciesMask(idx: u32) -> vec4f {
  if (P.numSpecies == 1u) { return vec4f(1.0); }
  return vec4f(vec4u(0u, 1u, 2u, 3u) == vec4u(idx));
}

fn sense(pos: vec2f, angle: f32, s: Species, senseWeight: vec4f) -> f32 {
  let dir = vec2f(cos(angle), sin(angle));
  let c = vec2i(pos + dir * s.sensorOffsetDst);
  var sum = 0.0;
  for (var ox = -s.sensorSize; ox <= s.sensorSize; ox++) {
    for (var oy = -s.sensorSize; oy <= s.sensorSize; oy++) {
      let i = cellIndex(c.x + ox, c.y + oy);
      sum += select(dot(senseWeight, trail[i]), WALL_SENSE, isWall(i));
    }
  }
  return sum;
}

fn wrapAngle(a: f32) -> f32 {
  return a - 2.0 * 3.14159265 * floor((a + 3.14159265) / (2.0 * 3.14159265));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x + gid.y * P.threadsPerRow;
  if (id >= P.numAgents) { return; }

  let agent = agents[id];
  let pos = agent.xy;
  let angle = agent.z;
  let sIdx = min(u32(agent.w), P.numSpecies - 1u);
  let s = P.species[sIdx];
  let mask = speciesMask(sIdx);
  let senseWeight = mask * 2.0 - 1.0;
  let w = f32(P.width);
  let h = f32(P.height);
  let dt = P.dt;
  let jones = P.jonesMode != 0u;

  var random = hash(u32(pos.y * w + pos.x) + hash(id + P.timeSeed));

  // Steer based on sensory data
  let weightForward = sense(pos, angle, s, senseWeight);
  let weightLeft = sense(pos, angle + s.sensorAngleRad, s, senseWeight);
  let weightRight = sense(pos, angle - s.sensorAngleRad, s, senseWeight);

  let randomSteerStrength = scaleToRange01(random);
  let turnSpeed = s.turnSpeed * 2.0 * PI;
  let steer = select(randomSteerStrength, 1.0, jones);
  var newAngle = angle;

  if (weightForward > weightLeft && weightForward > weightRight) {
    // Continue in same direction
  } else if (weightForward < weightLeft && weightForward < weightRight) {
    if (jones) {
      newAngle += select(-1.0, 1.0, randomSteerStrength >= 0.5) * turnSpeed * dt;
    } else {
      newAngle += (randomSteerStrength - 0.5) * 2.0 * turnSpeed * dt;
    }
  } else if (weightRight > weightLeft) {
    newAngle -= steer * turnSpeed * dt;
  } else if (weightLeft > weightRight) {
    newAngle += steer * turnSpeed * dt;
  }

  // Brush attract (1) / repel (2)
  if (P.brushAction == 1u || P.brushAction == 2u) {
    let f = brushFalloff(pos);
    if (f > 0.0) {
      let toBrush = P.brush - pos;
      var goal = atan2(toBrush.y, toBrush.x);
      if (P.brushAction == 2u) { goal += 3.14159265; }
      newAngle += wrapAngle(goal - newAngle) * min(1.0, P.brushStrength * dt * 5.0) * f;
    }
  }

  // Move with the pre-turn heading, like the HLSL (it reads the local copy).
  var newPos = pos + vec2f(cos(angle), sin(angle)) * dt * s.moveSpeed;
  let outside = newPos.x < 0.0 || newPos.x >= w || newPos.y < 0.0 || newPos.y >= h;

  let clamped = outside && !jones;
  if (clamped) {
    // Clamp to the map and pick a new random heading; no deposit.
    random = hash(random);
    newAngle = scaleToRange01(random) * 2.0 * PI;
    newPos = clamp(newPos, vec2f(0.0), vec2f(w - 1.0, h - 1.0));
  } else if (outside) {
    newPos -= floor(newPos / vec2f(w, h)) * vec2f(w, h);
    // Guard against rounding landing exactly on the far edge.
    newPos = select(newPos, vec2f(0.0), newPos >= vec2f(w, h));
  }
  // Wall test after clamp/wrap, matching the GL backend.
  let c = min(vec2u(newPos), vec2u(P.width - 1u, P.height - 1u));
  let i = c.y * P.width + c.x;
  if (isWall(i)) {
    // Blocked: stay put and pick a new random heading, like the edge rule; no deposit.
    random = hash(random);
    newAngle = scaleToRange01(random) * 2.0 * PI;
    newPos = pos;
  } else if (!clamped) {
    let deposited = trail[i] + mask * P.trailWeight * dt;
    trail[i] = select(min(vec4f(1.0), deposited), deposited, jones);
  }

  agents[id] = vec4f(newPos, newAngle, agent.w);
}
