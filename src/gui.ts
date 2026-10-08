import GUI from 'lil-gui';
import { MAX_SPECIES, PRESETS, SpawnMode, SpeciesSettings } from './config';
import { MAX_RADIUS, MIN_RADIUS, PrimaryAction } from './input';
import type { App } from './keyboard';

export interface GuiHandle {
  /** Rebuild the panel (after a preset load or species change replaced the objects it binds to). */
  rebuild(): void;
  setVisible(visible: boolean): void;
}

const TOUCH_ACTIONS: PrimaryAction[] = ['attract', 'repel', 'paint', 'erase', 'wall', 'unwall', 'spawn'];

const RESOLUTIONS: Record<string, [number, number]> = {
  '960x540': [960, 540],
  '1280x720': [1280, 720],
  '1920x1080': [1920, 1080],
  '2560x1440': [2560, 1440],
  '3840x2160': [3840, 2160],
};

/** Drop focus from a just-used select/checkbox so keyboard shortcuts reach the app again. */
const blurChoice = () => {
  const el = document.activeElement;
  if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type === 'checkbox')) el.blur();
};

/**
 * Builds the parameter panel. Live params mutate `state.settings` in place (backends read it every
 * step); structural params call app.reset(). Editing any sim parameter marks the preset as modified ("A*").
 */
export function createGui(app: App, maxAgents: number, backendName: string): GuiHandle {
  const state = app.state;
  let gui: GUI | undefined;

  const build = () => {
    gui?.destroy();
    gui = new GUI({ title: `Slime (${backendName})` });
    const s = state.settings;
    s.numAgents = Math.min(s.numAgents, maxAgents);

    const ctl = {
      resolution: `${s.width}x${s.height}`,
      reset: () => app.reset(),
      addSpecies: () => {
        if (s.species.length >= MAX_SPECIES) return;
        s.species.push(structuredClone(s.species[s.species.length - 1]));
        s.species[s.species.length - 1].colour = [Math.random(), Math.random(), Math.random()];
        app.markModified();
        app.reset();
        build();
      },
      removeSpecies: () => {
        if (s.species.length <= 1) return;
        s.species.pop();
        app.markModified();
        app.reset();
        build();
      },
    };

    // A modified preset ("A*") isn't among the options, so lil-gui shows the raw value and any
    // option (including the same preset) can be picked to reload it.
    gui
      .add(state, 'presetName', Object.keys(PRESETS))
      .name('Load preset')
      .listen()
      .onChange((name: string) => {
        blurChoice();
        app.loadPreset(name);
      });
    gui.add(state, 'paused').name('Paused (Space)').listen();
    gui.add(ctl, 'reset').name('Reset / respawn (R)');

    const sim = gui.addFolder('Simulation');
    sim.add(s, 'stepsPerFrame', 1, 10, 1).name('Steps per tick');
    sim
      .add(s, 'numAgents', 1000, maxAgents, 1000)
      .name('Agents')
      .onFinishChange(() => app.reset());
    sim
      .add(ctl, 'resolution', Object.keys(RESOLUTIONS))
      .name('Resolution')
      .onChange((r: string) => {
        [s.width, s.height] = RESOLUTIONS[r];
        app.markModified();
        app.reset();
      });
    sim
      .add(s, 'spawnMode', { Random: SpawnMode.Random, Point: SpawnMode.Point, InwardCircle: SpawnMode.InwardCircle, RandomCircle: SpawnMode.RandomCircle })
      .name('Spawn mode')
      .onChange(() => app.reset());
    sim.add(s, 'showAgentsOnly').name('Show agents only (A)').listen();
    sim.add(s, 'jonesMode').name('Jones (2010) mode (J)').listen();

    const trail = gui.addFolder('Trail');
    trail.add(s, 'trailWeight', 0, 50, 0.1).name('Trail weight');
    trail.add(s, 'decayRate', 0, 5, 0.01).name('Decay rate');
    trail.add(s, 'diffuseRate', 0, 50, 0.1).name('Diffuse rate');

    s.species.forEach((sp: SpeciesSettings, i: number) => {
      const f = gui!.addFolder(`Species ${i + 1}`);
      f.add(sp, 'moveSpeed', 0, 300, 0.5).name('Move speed');
      f.add(sp, 'turnSpeed', -200, 200, 0.5).name('Turn speed');
      f.add(sp, 'sensorAngleSpacing', 0, 180, 0.5).name('Sensor angle °');
      f.add(sp, 'sensorOffsetDst', 0, 100, 0.5).name('Sensor offset');
      f.add(sp, 'sensorSize', 0, 5, 1).name('Sensor size');
      f.addColor(sp, 'colour').name('Colour');
      if (i > 0) f.close();
    });
    gui.add(ctl, 'addSpecies').name('+ Add species');
    gui.add(ctl, 'removeSpecies').name('− Remove species');

    const input = state.input;
    const t = gui.addFolder('Tools');
    t.add(input.brush, 'radius', MIN_RADIUS, MAX_RADIUS, 1).name('Brush radius ([ ])').listen();
    t.add(input.brush, 'strength', 0, 10, 0.1).name('Brush strength');
    t.add(state.tools, 'spawnCount', 100, 20000, 100).name('Spawn per tick');
    t.add(input, 'foodStrength', 0, 50, 0.5).name('Food strength');
    t.add(state.tools, 'touchAction', TOUCH_ACTIONS).name('Touch action');
    t.add(app, 'clearTrail').name('Clear trail (C)');
    t.add(app, 'clearWalls').name('Clear walls (X)');
    t.add(app, 'clearFood').name('Clear food (F)');
    t.add({ help: () => app.toggleHelp() }, 'help').name('Controls help (?)');
    gui.add({ about: () => app.toggleAbout() }, 'about').name('About / credits (I)');

    // Any edit of a sim parameter (settings or species objects) makes the preset "modified".
    // showAgentsOnly is a display toggle, not a parameter.
    gui.onChange((e) => {
      blurChoice();
      if (e.property === 'showAgentsOnly') return;
      if (e.object === s || s.species.includes(e.object as SpeciesSettings)) app.markModified();
    });

    gui.show(!state.uiHidden);
    if (window.innerWidth < 700) gui.close();
  };

  build();
  return {
    rebuild: build,
    setVisible: (v) => gui?.show(v),
  };
}
