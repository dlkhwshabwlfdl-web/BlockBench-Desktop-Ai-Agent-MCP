/**
 * Structured workspace understanding + realtime state (requirements #2 and #10).
 *
 * Two halves:
 *  1. `capture*` functions turn live Blockbench objects into the plain, complete
 *     snapshots defined in `shared/protocol.ts`. The agent never needs to parse
 *     a `.bbmodel` file or reach into Blockbench internals itself.
 *  2. `StatePublisher` subscribes to Blockbench events, coalesces bursts, diffs the
 *     result against the previous signature and pushes only what changed.
 */

import {
  bb,
  groupClass,
  maybeFormat,
  maybeProject,
  outliner,
  previewApi,
  timeline,
  type BBAnimation,
  type BBKeyframe,
  type BBNode,
  type BBTexture,
} from './env.js';
import { BLOCKBENCH_EVENTS } from '../blockbench-api/generated/events.js';
import type {
  AnimationSummary,
  AnimatorSummary,
  KeyframeSummary,
  NodeSummary,
  PluginStateSnapshot,
  ProjectSnapshot,
  SelectionSummary,
  TextureSummary,
  ViewportState,
} from '../shared/protocol.js';

/* -------------------------------------------------------------- primitives */

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function vector(value: unknown, size = 3): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.slice(0, size).map((entry) => (typeof entry === 'number' ? entry : 0));
  while (out.length < size) out.push(0);
  return out;
}

function round(value: number, digits = 3): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

export function nodeSummary(node: BBNode, includeChildren = false): NodeSummary {
  const any = node as unknown as Record<string, unknown>;
  const isCubeLike = node.type === 'cube' || Array.isArray(any.from);
  const summary: NodeSummary = {
    uuid: String(node.uuid),
    name: String(node.name ?? ''),
    type: String(node.type ?? 'unknown'),
    parent: node.parent && node.parent !== 'root' ? String((node.parent as BBNode).uuid) : null,
  };
  if (isCubeLike) {
    summary.from = vector(any.from);
    summary.to = vector(any.to);
    const from = summary.from;
    const to = summary.to;
    if (from && to) summary.size = [round(to[0] - from[0]), round(to[1] - from[1]), round(to[2] - from[2])];
    summary.origin = vector(any.origin);
    summary.rotation = vector(any.rotation);
    summary.inflate = num(any.inflate) ?? 0;
    summary.mirror_uv = !!any.mirror_uv;
    summary.box_uv = !!any.box_uv;
    summary.autouv = num(any.autouv) ?? 0;
    summary.uv_offset = vector(any.uv_offset, 2);
    const faces = any.faces as Record<string, { texture?: string | false | null }> | undefined;
    if (faces) {
      const textures = new Set<string>();
      for (const face of Object.values(faces)) {
        if (face && typeof face.texture === 'string') textures.add(face.texture);
      }
      summary.texture = textures.size === 1 ? [...textures][0] : textures.size === 0 ? null : `${textures.size} textures`;
    }
  } else if (node.type === 'group' || node.type === 'armature_bone') {
    summary.origin = vector(any.origin);
    summary.rotation = vector(any.rotation);
  }
  if (typeof any.visibility === 'boolean') summary.visibility = any.visibility;
  if (typeof any.locked === 'boolean') summary.locked = any.locked;
  if (typeof any.export === 'boolean') summary.export = any.export;

  if (includeChildren && Array.isArray(node.children) && node.children.length) {
    summary.children = node.children.map((child) => nodeSummary(child as BBNode, true));
  }
  return summary;
}

export function captureProject(): ProjectSnapshot | null {
  const current = maybeProject();
  if (!current) return null;
  const bbApi = bb();
  const active = maybeFormat();
  const resolution = (current as unknown as { resolution?: { width: number; height: number } }).resolution;
  const textureWidth = num((current as unknown as { texture_width?: number }).texture_width);
  const textureHeight = num((current as unknown as { texture_height?: number }).texture_height);
  const groups = groupClass();
  const textures = captureTextures();

  return {
    blockbench_version: String(bbApi.version ?? 'unknown'),
    project_name: current.name ? String(current.name) : null,
    save_path: current.save_path ? String(current.save_path) : null,
    format_id: active ? active.id : 'none',
    format_name: active ? String(active.name ?? active.id) : 'none',
    format_bone_rig: !!active?.bone_rig,
    format_box_uv: !!active?.box_uv,
    format_animation_mode: !!active?.animation_mode,
    format_rotation_limit: active ? (active.rotation_limit as boolean | number) : false,
    target_version: (active as unknown as { target?: string })?.target ?? null,
    // Some formats (notably `free`) keep only texture_width/texture_height and have no
    // `resolution` object. Reporting the default 16 then would tell the agent the UV grid
    // is half the size it really is, so fall back to the texture dimensions.
    resolution: {
      width: num(resolution?.width) ?? textureWidth ?? 16,
      height: num(resolution?.height) ?? textureHeight ?? 16,
    },
    texture_size: [textureWidth ?? 0, textureHeight ?? 0],
    saved: !!current.saved,
    element_count: current.elements?.length ?? 0,
    group_count: groups?.all?.length ?? 0,
    texture_count: textures.length,
    animation_count: captureAnimations().length,
  };
}

export function captureNodeTree(maxDepth = 12): NodeSummary[] {
  const out = outliner();
  const roots = Array.isArray(out?.root) ? out.root : [];
  const walk = (node: BBNode, depth: number): NodeSummary => {
    const summary = nodeSummary(node, false);
    if (depth < maxDepth && Array.isArray(node.children) && node.children.length) {
      summary.children = node.children.map((child) => walk(child as BBNode, depth + 1));
    }
    return summary;
  };
  return roots.map((node) => walk(node as BBNode, 0));
}

export function captureTextures(): TextureSummary[] {
  const current = maybeProject();
  const list = (current?.textures ?? []) as BBTexture[];
  return list.map((texture) => {
    const source = typeof texture.source === 'string' ? texture.source : null;
    return {
      uuid: String(texture.uuid),
      name: String(texture.name ?? ''),
      width: num(texture.width),
      height: num(texture.height),
      path: texture.path ? String(texture.path) : null,
      internal: !!texture.internal,
      selected: !!texture.selected,
      particle: !!texture.particle,
      render_mode: texture.render_mode ? String(texture.render_mode) : null,
      has_source: !!source,
      source_kind: source ? (source.startsWith('data:') ? 'data_url' : 'path') : 'empty',
    };
  });
}

export function keyframeSummary(keyframe: BBKeyframe): KeyframeSummary {
  const points = Array.isArray(keyframe.data_points) ? keyframe.data_points : [];
  return {
    uuid: String(keyframe.uuid),
    time: round(num(keyframe.time) ?? 0),
    channel: String(keyframe.channel ?? ''),
    interpolation: String(keyframe.interpolation ?? ''),
    color: num(keyframe.color) ?? undefined,
    data_points: points.map((point) => {
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(point)) {
        if (key === 'keyframe') continue;
        copy[key] = typeof value === 'number' ? round(value) : value;
      }
      return copy;
    }),
  };
}

export function captureAnimations(): BBAnimation[] {
  // Animation.all is not a documented static; Animator.animations is (js/animations/animation.js:104).
  const registry = (globalThis as unknown as { Animator?: { animations?: BBAnimation[] } }).Animator;
  const list = registry?.animations;
  return Array.isArray(list) ? list : [];
}

export function animationSummary(animation: BBAnimation, withAnimators = false): AnimationSummary {
  const animators = Object.values(animation.animators ?? {});
  let keyframes = 0;
  const animatorSummaries: AnimatorSummary[] = [];
  for (const [key, animator] of Object.entries(animation.animators ?? {})) {
    const frames = Array.isArray(animator.keyframes) ? animator.keyframes : [];
    keyframes += frames.length;
    if (withAnimators) {
      animatorSummaries.push({
        uuid: String(animator.uuid ?? ''),
        key: key,
        type: String(animator.type ?? ''),
        name: String((animator as unknown as { _name?: string })._name ?? animator.name ?? ''),
        channels: [...new Set(frames.map((frame) => String(frame.channel)))],
        keyframe_count: frames.length,
      });
    }
  }
  return {
    uuid: String(animation.uuid),
    name: String(animation.name ?? ''),
    length: round(num(animation.length) ?? 0),
    loop: String(animation.loop ?? 'once'),
    playing: !!animation.playing,
    selected: !!animation.selected,
    snapping: num(animation.snapping) ?? undefined,
    animator_count: animators.length,
    keyframe_count: keyframes,
    markers: (animation.markers ?? []).map((marker) => String((marker as { name?: string }).name ?? '')),
    animators: animatorSummaries,
  };
}

export function captureSelection(): SelectionSummary {
  const out = outliner();
  const groupApi = groupClass();
  const elements = (out?.elements ?? []).filter((node) => !!node.selected) as BBNode[];
  const groups = (groupApi?.multi_selected ?? []).length
    ? (groupApi.multi_selected as BBNode[])
    : ((out?.root ?? []).filter((node) => node.type === 'group' && node.selected) as BBNode[]);
  const animationApi = (globalThis as unknown as { Animation?: { selected?: BBAnimation } }).Animation;
  const selectedAnimation = animationApi?.selected ?? null;
  const timelineApi = (globalThis as unknown as { Timeline?: { selected?: BBKeyframe[] } }).Timeline;
  const selectedKeyframes = Array.isArray(timelineApi?.selected) ? timelineApi!.selected! : [];
  const modes = (globalThis as unknown as { Modes?: { id?: string } }).Modes;

  return {
    groups: groups.map((node) => nodeSummary(node)),
    elements: elements.map((node) => nodeSummary(node)),
    textures: captureTextures().filter((texture) => texture.selected),
    animation: selectedAnimation ? String(selectedAnimation.name) : null,
    keyframes: selectedKeyframes.map((keyframe) => keyframeSummary(keyframe)),
    mode: String(modes?.id ?? 'unknown'),
  };
}

export function captureViewport(): ViewportState | null {
  let previews: { selected: unknown; all: unknown[] };
  try {
    previews = previewApi() as unknown as { selected: unknown; all: unknown[] };
  } catch {
    return null;
  }
  const selected = previews?.selected as
    | {
        id?: string;
        camera?: { position?: { toArray(): number[] }; zoom?: number };
        controls?: { target?: { toArray(): number[] } };
      }
    | null
    | undefined;

  const project = maybeProject();
  const elements = (project?.elements ?? []) as BBNode[];
  const visible = elements.filter((element) => (element as unknown as { visibility?: boolean }).visibility !== false);

  let viewMode: string | null = null;
  try {
    const display = (globalThis as unknown as { DisplayMode?: { id?: string } }).DisplayMode;
    viewMode = display?.id ?? null;
  } catch {
    viewMode = null;
  }

  const camera = selected?.camera;
  const target = selected?.controls?.target;
  return {
    preview_id: selected?.id ?? null,
    view_mode: viewMode,
    camera: camera
      ? {
          position: camera.position?.toArray?.() ?? [0, 0, 0],
          target: target?.toArray?.() ?? [0, 0, 0],
          zoom: num((camera as { zoom?: number }).zoom) ?? 1,
          rotation: [],
        }
      : null,
    shading: (() => {
      try {
        const settings = (globalThis as unknown as { settings?: Record<string, { value?: unknown }> }).settings;
        return !!settings?.shading?.value;
      } catch {
        return false;
      }
    })(),
    display_slot: (() => {
      try {
        return (globalThis as unknown as { DisplayMode?: { display_slot?: string } }).DisplayMode?.display_slot ?? null;
      } catch {
        return null;
      }
    })(),
    visible_elements: visible.length,
    hidden_elements: elements.length - visible.length,
  };
}

export function captureUndo(): { index: number; length: number } | null {
  const current = maybeProject();
  const undoSystem = current?.undo;
  if (!undoSystem) return null;
  return {
    index: num((undoSystem as unknown as { index?: number }).index) ?? 0,
    length: Array.isArray((undoSystem as unknown as { history?: unknown[] }).history)
      ? (undoSystem as unknown as { history: unknown[] }).history.length
      : 0,
  };
}

let revision = 0;

export function buildStateSnapshot(connected: boolean): PluginStateSnapshot {
  const project = captureProject();
  const selection = captureSelection();
  const animations = captureAnimations();
  const selectedAnimation = animations.find((animation) => animation.selected) ?? null;
  const textures = captureTextures();
  const timelineApi = (() => {
    try {
      return timeline();
    } catch {
      return null;
    }
  })();
  const keyframes = animations.reduce((total, animation) => {
    return (
      total +
      Object.values(animation.animators ?? {}).reduce(
        (sum, animator) => sum + (Array.isArray(animator.keyframes) ? animator.keyframes.length : 0),
        0,
      )
    );
  }, 0);

  return {
    connected,
    project,
    counts: {
      elements: project?.element_count ?? 0,
      groups: project?.group_count ?? 0,
      textures: textures.length,
      animations: animations.length,
      keyframes,
    },
    animation: selectedAnimation
      ? {
          name: selectedAnimation.name,
          time: round(num((timelineApi as unknown as { time?: number })?.time) ?? 0),
          length: round(num(selectedAnimation.length) ?? 0),
          playing: !!selectedAnimation.playing,
        }
      : null,
    selection: {
      groups: selection.groups.map((node) => node.name),
      elements: selection.elements.map((node) => node.name),
      textures: selection.textures.map((texture) => texture.name),
      count: selection.groups.length + selection.elements.length,
    },
    viewport: captureViewport(),
    undo: captureUndo(),
    revision: ++revision,
    updated_at: Date.now(),
  };
}

/* ------------------------------------------------------------- events list */

/**
 * Events worth forwarding. Every name is checked against the list extracted from
 * the installed Blockbench build; anything unknown is dropped with a warning
 * instead of silently subscribing to a typo.
 */
export const TRACKED_EVENTS: readonly string[] = [
  'add_cube',
  'add_group',
  'add_mesh',
  'add_locator',
  'add_billboard',
  'add_texture',
  'add_animation',
  'add_animation_controller',
  'remove',
  'remove_animation',
  'finish_edit',
  'finished_edit',
  'init_edit',
  'undo',
  'redo',
  'update_selection',
  'finish_selection_change',
  'update_texture_selection',
  'select_texture',
  'update_visibility',
  'update_transform',
  'update_all',
  'update_keyframe_selection',
  'update_project_resolution',
  'update_project_settings',
  'select_animation',
  'parse',
  'parsed',
  'load_project',
  'save_project',
  // The format is not known until a project exists, so these three are what trigger the
  // capability re-probe; without them the boot-time report would stand forever.
  'new_project',
  'setup_project',
  'select_format',
  'select_project',
  'unselect_project',
  'close_project',
  'select_mode',
  'unselect_mode',
  'change_view_mode',
  'update_camera_position',
  'update_view',
  'update_scene_shading',
  'timeline_play',
  'timeline_pause',
  'change_texture_path',
  'edit_texture',
  'group_elements',
  'saved_state_changed',
  'update_geometry',
];

export function verifiedTrackedEvents(): { names: string[]; dropped: string[] } {
  const known = new Set(BLOCKBENCH_EVENTS);
  const names: string[] = [];
  const dropped: string[] = [];
  for (const name of TRACKED_EVENTS) {
    if (known.has(name)) names.push(name);
    else dropped.push(name);
  }
  return { names, dropped };
}

/* --------------------------------------------------------------- publisher */

export type StateListener = (state: PluginStateSnapshot, changed: string[]) => void;

export class StatePublisher {
  private handles: Array<{ delete(): void }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Set<string>();
  private lastSignatures = new Map<string, string>();
  private started = false;
  private connected = false;

  constructor(
    private readonly intervalMs: number,
    private readonly onPublish: (state: PluginStateSnapshot, changed: string[]) => void,
    private readonly onEvent: (name: string, data: unknown) => void,
    private readonly onWarn: (message: string) => void,
  ) {}

  setConnected(value: boolean): void {
    this.connected = value;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { names, dropped } = verifiedTrackedEvents();
    if (dropped.length) this.onWarn(`ignoring unknown event names: ${dropped.join(', ')}`);

    for (const name of names) {
      try {
        const handle = bb().on(name, (data: unknown) => {
          this.pending.add(name);
          if (this.intervalMs <= 0) {
            this.flush();
          } else if (this.timer === null) {
            this.timer = setTimeout(() => {
              this.timer = null;
              this.flush();
            }, this.intervalMs);
          }
          this.onEvent(name, data);
        });
        this.handles.push(handle);
      } catch (error) {
        this.onWarn(`could not subscribe to "${name}": ${(error as Error).message}`);
      }
    }
  }

  stop(): void {
    for (const handle of this.handles) {
      try {
        handle.delete();
      } catch {
        /* ignore */
      }
    }
    this.handles = [];
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** Force a publish (used by the Observe button and after mutations). */
  flush(): void {
    const state = buildStateSnapshot(this.connected);
    // diff() consumes the pending event names, so it must run before the clear.
    const changed = this.diff(state);
    this.pending.clear();
    this.onPublish(state, changed);
  }

  private signature(state: PluginStateSnapshot): Map<string, string> {
    const map = new Map<string, string>();
    map.set('project', JSON.stringify(state.project));
    map.set('counts', JSON.stringify(state.counts));
    map.set('selection', JSON.stringify(state.selection));
    map.set('animation', JSON.stringify(state.animation));
    map.set('viewport', JSON.stringify(state.viewport));
    map.set('undo', JSON.stringify(state.undo));
    return map;
  }

  private diff(state: PluginStateSnapshot): string[] {
    const current = this.signature(state);
    const changed: string[] = [];
    for (const [key, value] of current) {
      if (this.lastSignatures.get(key) !== value) changed.push(key);
    }
    // Also surface which model objects were touched since the last tick.
    for (const event of this.pending) {
      if (!changed.includes(event)) changed.push(event);
    }
    this.lastSignatures = current;
    return changed;
  }
}
