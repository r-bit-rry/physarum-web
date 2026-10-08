# Physarum Web

A WebGPU port of Sebastian Lague's Unity [Slime-Simulation](https://github.com/SebLague/Slime-Simulation) ([video](https://www.youtube.com/watch?v=X-iSQQgOd1A)), with a WebGL2 fallback. The Unity version is in turn based on Jeff Jones, *Characteristics of pattern formation and evolution in approximations of Physarum transport networks* (Artificial Life, 2010): https://uwe-repository.worktribe.com/output/980579

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + static bundle in dist/
npm run preview    # serve dist/
```

`dist/` is a fully static site with a relative base (`base: './'` in `vite.config.ts`), so it works from any path. It needs no special headers.

## Deploy

**GitHub Pages.** `.github/workflows/deploy.yml` builds and publishes on every push to `main`. It takes effect once this folder is the root of its own repository.
1. Push the repo to GitHub.
2. In Settings → Pages, set Source to **GitHub Actions**.
3. The site is served at `[https://r-bit-rry.github.io/physarum-web/](https://r-bit-rry.github.io/physarum-web/)`.

**Anywhere else** (Netlify, Cloudflare Pages, Vercel, S3): use build command `npm run build` and publish directory `dist`.

WebGPU needs a secure context. Every host above serves HTTPS, and `localhost` counts as secure too.

### URL parameters

| Param | Values | Default |
|---|---|---|
| `preset` | `A` `B` `C` `D` (ported from `Assets/Settings/*.asset`) | `A` |
| `backend` | `webgpu`, `webgl2` | WebGPU, falling back to WebGL2 if unavailable |
| `agents` | agent count, clamped to the device limit | the preset's value |

Example: `?preset=D&agents=1000000`

### Controls

You don't need to pick a mode. Every tool has its own gesture. Press `?` in the app to see these tables.

| Gesture | Action |
|---|---|
| Left drag | attract agents to the cursor |
| Right drag | repel agents |
| Shift + left / right drag | paint / erase trail |
| Ctrl/⌘ + left / right drag | draw / erase walls (agents can't enter them and steer away from them) |
| Alt + drag, or hold `E` | spawn slime at the cursor (recycles the oldest agents) |
| Double-click | add a food source, or remove the one under the cursor (max 16). Food emits trail into every species channel |
| Wheel / trackpad pinch | zoom around the cursor (1×–16×) |
| Middle drag, or Space + drag | pan |
| Alt + wheel | brush size |
| Touch: one finger | the "Primary action" chosen in the Tools folder (attract by default) |
| Touch: two fingers | pinch zoom and pan |

The brush circle's colour shows the current action: cyan attract, orange repel, green paint, grey erase, white walls (dashed means erase), magenta spawn.

| Key | Action |
|---|---|
| Space (tap) | pause / resume |
| `R` | reset / respawn |
| `1`–`4` | load presets A–D |
| `C` / `X` / `F` | clear trail / walls / food |
| `A` | agents-only view |
| `J` | Jones (2010) mode |
| `H` | hide / show the UI |
| `[` / `]` | brush size |
| `0` | reset zoom |
| `S` | save a PNG |
| `?` | help overlay (`Esc` closes it) |
| `I` | about / credits |

Shortcuts are ignored while you're typing in a GUI number field.

- The lil-gui panel sets every global and per-species parameter. Changes apply live.
- "Load preset" shows the loaded preset. Once you edit a parameter it shows `A*`. Pick any entry to reload a preset.
- Changing the agent count, resolution, spawn mode or species count respawns the simulation.
- The Tools folder holds the brush radius and strength, spawn rate, food strength, the touch action, and clear buttons.

## Architecture

The simulation steps at a fixed 50 Hz with `dt = 0.02`, the same as Unity's `FixedUpdate`. Each tick runs `stepsPerFrame` steps, so behaviour doesn't depend on the display's refresh rate.

**WebGPU** (`src/webgpu/`) keeps all state in storage buffers: agents as `vec4f` (x, y, angle, species), and two ping-pong `vec4f` trail buffers with one channel per species. All substeps for a tick go into one command encoder:

1. `agents.wgsl`: sense, steer, move, then a racy read-modify-write deposit (as in Unity). Dispatch switches to 2D above 4.2M agents.
2. `diffuse.wgsl`: 3×3 blur and decay, using an 8×8 workgroup with a shared-memory tile and halo. Brush paint/erase and food emission also happen here.
3. Swap the ping-pong bind groups.

Walls are a `u32` mask (`walls.wgsl` stamps the brush disc once per tick, and main.ts fills in fast strokes). Shaders skip the mask reads until the first wall is drawn.

`render.wgsl` draws a full-screen triangle that maps species channels to colours, or draws agents as points when "show agents only" is on.

**WebGL2** (`src/webgl2/`):
- Agents live in an RGBA32F texture and are updated by a fragment shader into a ping-pong framebuffer.
- Deposit draws `gl.POINTS` with additive blending into the trail texture. The trail is RGBA32F when `EXT_float_blend` is available and RGBA16F otherwise.
- Diffuse and render are fragment passes.
- Requires `EXT_color_buffer_float`. Agent count is capped at 1M.

## Differences from the Unity version

- **Fixed time step.** Unity's `deltaTime` is replaced by a fixed tick. At most 4 ticks run per animation frame, so a slow GPU slows the simulation down instead of falling into a catch-up spiral.
- **WebGL2 deposit.** It happens after the move pass and uses blending, so no deposits are lost. The `min(1)` clamp is applied in the next diffuse pass. Patterns match closely but not bit-for-bit.
- **Jones (2010) mode** (optional toggle):
  - full ±turn steps instead of a random fraction
  - multiplicative decay
  - toroidal wrap
  - no clamp on the trail

  Jones's one-agent-per-cell occupancy rule is not implemented. It would be non-deterministic on a GPU.
- **Species.** Up to 4 (one RGBA channel each). Unity supported 3.

## Performance

Measured on an Apple M4 Pro with headless Chrome, preset A at 1920×1080, 2 steps per tick:

| Backend | Agents | Result |
|---|---|---|
| WebGPU | 250k / 1M / 4M | locked 60 fps (vsync) |
| WebGPU | 8M | ~50 fps uncapped; simulation-bound |
| WebGL2 | 250k / 1M (cap) | locked 60 fps (vsync) |

These numbers come from `scripts/shot.mjs`, which runs Chrome with vsync disabled. Uncapped fps mostly measures render cost: the simulation only advances 50 ticks per second, however fast the frames come. For a rough comparison, WebGPU rendered about 3,500 frames per second at 1M agents and WebGL2 about 540 before walls, food and zoom were added. With those features the same run measured about 1,600–1,900 (WebGPU) and 370–730 (WebGL2), on a machine busy with other work, so the numbers are noisy. Drawing walls adds the mask reads back, which costs WebGPU roughly another 20–40%.

### Verification helper

```sh
node scripts/shot.mjs "http://localhost:5173/?preset=A&backend=webgpu" /tmp/a.png 8
```

This runs headless Chrome with WebGPU enabled, prints the backend, fps and any console errors, and saves a screenshot.

## Credits

- **Web version:** browser port (WebGPU / WebGL2), interaction and development by [Roy Belio (r-bit-rry)](https://github.com/r-bit-rry).
- **Original simulation:** [Sebastian Lague](https://github.com/SebLague): [SebLague/Slime-Simulation](https://github.com/SebLague/Slime-Simulation) and [Coding Adventure: Ant and Slime Simulations](https://www.youtube.com/watch?v=X-iSQQgOd1A). The presets and core algorithm come from his project.
- **Research:** Jeff Jones, [*Characteristics of pattern formation and evolution in approximations of Physarum transport networks*](https://uwe-repository.worktribe.com/output/980579), Artificial Life 16(2), 2010 ([doi](https://doi.org/10.1162/artl.2010.16.2.16202)). His wider work is collected in [*From Pattern Formation to Material Computation: Multi-agent Modelling of Physarum Polycephalum*](https://doi.org/10.1007/978-3-319-16823-4) (Springer, 2015).

The same credits appear in the app (press `I`, or use "About / credits" in the panel).

## License

GNU GPL v3, the same as the original. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
