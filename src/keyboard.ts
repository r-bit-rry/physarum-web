import { InputState, SimSettings, View } from './config';
import type { PointerController, PrimaryAction } from './input';

export interface Tools {
  /** Agents recycled per tick while spawning. */
  spawnCount: number;
  /** What a single-finger touch drag does. */
  touchAction: PrimaryAction;
}

export interface AppState {
  settings: SimSettings;
  /** Loaded preset name, with a trailing '*' once any parameter has been edited. */
  presetName: string;
  view: View;
  input: InputState;
  paused: boolean;
  tools: Tools;
  uiHidden: boolean;
}

/** Actions shared by the GUI, keyboard and window.slime (built in main.ts). */
export interface App {
  state: AppState;
  togglePause(): void;
  /** Respawn with the current settings (also used after structural GUI edits). */
  reset(): void;
  loadPreset(name: string): void;
  /** Mark the current settings as edited relative to the loaded preset. */
  markModified(): void;
  clearTrail(): void;
  clearWalls(): void;
  clearFood(): void;
  toggleAgentsOnly(): void;
  toggleJones(): void;
  toggleUI(): void;
  scaleBrush(factor: number): void;
  resetView(): void;
  savePng(): void;
  toggleHelp(show?: boolean): void;
  toggleAbout(show?: boolean): void;
}

const PRESET_KEYS: Record<string, string> = { '1': 'A', '2': 'B', '3': 'C', '4': 'D' };

/** Global shortcuts. Space is a tap-to-pause, but held Space + drag pans (handled by input.ts). */
export function createKeyboard(app: App, pointer: PointerController): void {
  // Only text entry swallows shortcuts; a focused checkbox/select/button must not.
  const NON_TEXT = new Set(['checkbox', 'radio', 'color', 'range', 'button', 'submit', 'reset']);
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    if (t instanceof HTMLInputElement) return !NON_TEXT.has(t.type);
    return t.tagName === 'TEXTAREA' || t.isContentEditable;
  };

  // Capture phase: lil-gui stops key events from propagating out of its panel, so a focused
  // GUI element would otherwise swallow shortcuts (and the keyup of a held Space/E).
  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.ctrlKey || e.metaKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Hold keys use e.code: with Option held, macOS reports E as a dead key.
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) {
        pointer.spaceHeld = true;
        pointer.panned = false;
      }
      return;
    }
    if (e.code === 'KeyE') {
      pointer.keySpawn = true;
      e.preventDefault();
      return;
    }
    const action = actionFor(k);
    if (!action) return;
    // Stop a focused <select>/checkbox from also acting on the key (type-ahead would reload a preset).
    // Chrome runs select type-ahead on keypress, so blur as well.
    e.preventDefault();
    if (e.target instanceof HTMLSelectElement) e.target.blur();
    if (e.repeat && k !== '[' && k !== ']') return;
    action();
  }, true);

  const actionFor = (k: string): (() => void) | undefined => {
    if (k in PRESET_KEYS) return () => app.loadPreset(PRESET_KEYS[k]);
    switch (k) {
      case 'r': return app.reset;
      case 'c': return app.clearTrail;
      case 'x': return app.clearWalls;
      case 'f': return app.clearFood;
      case 'a': return app.toggleAgentsOnly;
      case 'j': return app.toggleJones;
      case 'h': return app.toggleUI;
      case '[': return () => app.scaleBrush(1 / 1.15);
      case ']': return () => app.scaleBrush(1.15);
      case '0': return app.resetView;
      case 's': return app.savePng;
      case '?':
      case '/': return () => app.toggleHelp();
      case 'i': return () => app.toggleAbout();
      case 'Escape': return () => {
        app.toggleHelp(false);
        app.toggleAbout(false);
      };
    }
  };

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && pointer.spaceHeld) {
      e.preventDefault(); // don't click a focused GUI button
      pointer.spaceHeld = false;
      if (!pointer.panned && !typing(e)) app.togglePause();
    } else if (e.code === 'KeyE') {
      pointer.keySpawn = false;
    }
  }, true);

  window.addEventListener('blur', () => {
    pointer.spaceHeld = false;
    pointer.keySpawn = false;
  });
}
