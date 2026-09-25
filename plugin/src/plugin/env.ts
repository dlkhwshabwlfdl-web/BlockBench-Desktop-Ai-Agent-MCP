/**
 * Runtime environment layer for the Blockbench plugin.
 *
 * Rule #1 of this project is "never guess Blockbench APIs". Everything in this
 * file exists to enforce that: the plugin never imports Blockbench code, it
 * resolves the globals Blockbench itself assigns to `window` and it *checks they
 * exist* before use. Anything missing raises a precise error that is reported
 * back to the agent as a capability limitation instead of throwing an
 * unhelpful `undefined is not a function` deep inside a tool handler.
 *
 * The interfaces below describe exactly the API subset this plugin uses. Each
 * one was read out of the installed build (see docs/BLOCKBENCH-API-REPORT.md
 * and the extracted sources in `.blockbench-api/src/js/**`), never invented.
 */

export class MissingApiError extends Error {
  readonly apiName: string;
  constructor(apiName: string, detail?: string) {
    super(`Blockbench API "${apiName}" is not available${detail ? `: ${detail}` : ''}`);
    this.name = 'MissingApiError';
    this.apiName = apiName;
  }
}

export class NeedProjectError extends Error {
  constructor() {
    super('No Blockbench project is currently open. Open or create a project before running model tools.');
    this.name = 'NeedProjectError';
  }
}

/* ------------------------------------------------------------------ globals */

type GlobalScope = Record<string, unknown>;

function scope(): GlobalScope {
  return globalThis as unknown as GlobalScope;
}

export function tryGlobal<T = unknown>(name: string): T | undefined {
  const value = scope()[name];
  return value === undefined ? undefined : (value as T);
}

export function getGlobal<T = unknown>(name: string, detail?: string): T {
  const value = tryGlobal<T>(name);
  if (value === undefined) throw new MissingApiError(name, detail);
  return value;
}

export function hasGlobal(name: string): boolean {
  return scope()[name] !== undefined;
}

export function hasMethod(target: unknown, name: string): boolean {
  return !!target && typeof (target as Record<string, unknown>)[name] === 'function';
}

export function hasProperty(target: unknown, name: string): boolean {
  return !!target && name in (target as object);
}

/* -------------------------------------------------------------------- shapes */

export interface BBVector {
  [index: number]: number;
  length: number;
}

export interface BBNode {
  uuid: string;
  name: string;
  type: string;
  parent: BBNode | 'root' | null;
  children: BBNode[] | null;
  selected: boolean;
  visibility?: boolean;
  locked?: boolean;
  export?: boolean;
  icon?: string;
  menu?: unknown;
  addTo(target?: BBNode | 'root', index?: number): BBNode;
  removeFromParent(): void;
  duplicate(): BBNode;
  remove(remove_children?: boolean): void;
  select(event?: unknown, is_outliner_click?: boolean): unknown;
  unselect(unselect_parent?: boolean): void;
  getSaveCopy(): Record<string, unknown>;
  sanitizeName(): string;
  createUniqueName(additional?: BBNode[]): string | false;
  getParentArray(): BBNode[];
  getAllAncestors(): BBNode[];
  extend(data: Record<string, unknown>): unknown;
}

export interface BBCubeFace {
  texture: string | false | null;
  uv: number[] | null;
  rotation: number;
  tint: number;
  cullface: string | null;
  enabled: boolean;
  material_name?: string;
}

export interface BBCube extends BBNode {
  from: number[];
  to: number[];
  origin: number[];
  rotation: number[];
  inflate: number;
  stretch: number[];
  mirror_uv: boolean;
  shade: boolean;
  autouv: number;
  uv_offset: number[];
  box_uv: boolean;
  color: number;
  faces: Record<string, BBCubeFace>;
  getSelectedFaces(): BBCubeFace[] | null;
  applyTexture(undo?: boolean, texture?: unknown): void;
  /** js/outliner/types/cube.js: recomputes automatic UVs from the cube bounds. */
  mapAutoUV(options?: Record<string, unknown>): void;
}

export interface BBGroup extends BBNode {
  origin: number[];
  rotation: number[];
  is_catch_bone?: boolean;
  scope?: number;
}

export interface BBOutlinerElement extends BBNode {
  from?: number[];
  to?: number[];
}

export interface BBKeyframeDataPoint {
  x?: unknown;
  y?: unknown;
  z?: unknown;
  effect?: string;
  locator?: string;
  script?: string;
  [key: string]: unknown;
}

export interface BBKeyframe {
  uuid: string;
  time: number;
  channel: string;
  color: number;
  interpolation: string;
  uniform: boolean;
  data_points: BBKeyframeDataPoint[];
  animator: BBAnimator | null;
  extend(data: Record<string, unknown>): unknown;
  get(axis: string, data_point?: number): number | string;
  set(axis: string, value: unknown, data_point?: number): void;
  calc(axis: string, data_point?: number): unknown;
  remove(): void;
  select(event?: unknown): void;
  [key: string]: unknown;
}

export interface BBAnimator {
  uuid: string | null;
  name?: string;
  type: string;
  animation: BBAnimation | null;
  keyframes: BBKeyframe[];
  selected?: boolean;
  muted?: boolean;
  addKeyframe(keyframe: BBKeyframe): BBAnimator;
  select(event?: unknown, force?: boolean): BBAnimator;
  addToTimeline(): BBAnimator;
  createKeyframe?(): BBKeyframe;
  [key: string]: unknown;
}

export interface BBAnimation {
  uuid: string;
  name: string;
  length: number;
  loop: 'once' | 'loop' | 'hold';
  playing: boolean;
  selected: boolean;
  snapping: number;
  override: boolean;
  type: 'animation' | 'animation_controller';
  animators: Record<string, BBAnimator>;
  markers: Array<Record<string, unknown>>;
  path?: string;
  saved_name?: string;
  select(): BBAnimation;
  add(undo?: boolean): BBAnimation;
  remove(undo?: boolean, remove_from_file?: boolean): void;
  setLength(length?: number): void;
  setLoop(loop: string, undo?: boolean): void;
  getBoneAnimator(node: BBNode): BBAnimator | undefined;
  getMaxLength(): number;
  createUniqueName(): string;
  [key: string]: unknown;
}

export interface BBTexture {
  uuid: string;
  name: string;
  width: number | null;
  height: number | null;
  path: string | null;
  source: string | null;
  internal: boolean;
  selected: boolean;
  particle: boolean;
  render_mode: string | null;
  group?: string | null;
  canvas?: HTMLCanvasElement | null;
  ctx?: CanvasRenderingContext2D | null;
  fromDataURL(url: string): void;
  fromFile?(...args: unknown[]): void;
  fromPath?(...args: unknown[]): void;
  load(cb?: () => void): void;
  select(event?: unknown): void;
  extend(data: Record<string, unknown>): unknown;
  add?(undo?: boolean): void;
  getDataURL?(): string;
  [key: string]: unknown;
}

export interface BBPreview {
  id: string;
  canvas: HTMLCanvasElement;
  camera: unknown;
  controls: unknown;
  width: number;
  height: number;
  render(): void;
  screenshot(options: { crop?: boolean; width?: number; height?: number }, callback: (dataUrl: string) => void): void;
  [key: string]: unknown;
}

export interface BBScreencam {
  screenshotPreview(preview: BBPreview, options: unknown, cb: (url: string) => void): void;
  advancedScreenshot(preview: BBPreview, options: Record<string, unknown>, cb: (url: string) => void): Promise<unknown>;
  screenshot2DEditor(options: unknown, cb: (url: string) => void): void;
  returnScreenshot(dataUrl: string, cb?: (url: string) => void, blob?: unknown): void;
  [key: string]: unknown;
}

export interface BBUndoSystem {
  history: unknown[];
  index: number;
  initEdit(aspects: Record<string, unknown>, amended?: boolean): void;
  finishEdit(message: string, aspects?: Record<string, unknown>): void;
  initSelection(aspects?: Record<string, unknown>): void;
  finishSelection(message: string, aspects?: Record<string, unknown>): void;
  cancelEdit(revert_changes?: boolean): void;
  undo(remote?: unknown, amended?: unknown): void;
  redo(remote?: unknown, amended?: unknown): void;
  [key: string]: unknown;
}

export interface BBModelProject {
  uuid: string;
  name: string;
  save_path: string | null;
  format: BBFormat;
  resolution: { width: number; height: number };
  texture_width: number;
  texture_height: number;
  box_uv: boolean;
  elements: unknown[];
  textures: BBTexture[];
  groups?: unknown[];
  saved: boolean;
  undo: BBUndoSystem;
  select(): boolean;
  close(force?: boolean): Promise<void>;
  getFileExtension(): string;
  [key: string]: unknown;
}

export interface BBFormat {
  id: string;
  name: string;
  description?: string;
  bone_rig: boolean;
  box_uv: boolean;
  animation_mode: boolean;
  rotation_limit: boolean | number;
  single_texture: boolean;
  per_texture_uv_size: boolean;
  optional_box_uv?: boolean;
  rotate_cubes: boolean;
  meshes: boolean;
  locators: boolean;
  target?: string;
  [key: string]: unknown;
}

export interface BBBlockbenchApi {
  version: string;
  isApp: boolean;
  isWeb: boolean;
  isMobile: boolean;
  isTouch: boolean;
  platform: string;
  operating_system: string;
  browser: string;
  flags: Record<string, boolean>;
  Format: BBFormat | 0;
  Project: BBModelProject | 0;
  readonly Undo: BBUndoSystem | undefined;
  events: Record<string, unknown[]>;
  showQuickMessage(message: string, time?: number): void;
  showStatusMessage(message: string, time?: number): void;
  showMessageBox(options: Record<string, unknown>, cb?: (...args: unknown[]) => void): unknown;
  textPrompt(title: string, value: string, callback: (text: string) => void, options?: Record<string, unknown>): Promise<string>;
  openLink(link: string): void;
  on(event: string, cb: (data: unknown) => unknown): { delete(): void };
  once(event: string, cb: (data: unknown) => unknown): { delete(): void };
  addListener(event: string, cb: (data: unknown) => unknown): { delete(): void };
  removeListener(event: string, cb: (data: unknown) => unknown): void;
  dispatchEvent(event: string, data: unknown): unknown[];
  isNewerThan(version: string): boolean;
  isOlderThan(version: string): boolean;
  addCSS(css: string, layer?: string): { delete(): void };
  getIconNode(icon: unknown, color?: string): HTMLElement;
  import(options: Record<string, unknown>, cb: (files: Array<{ path: string; content?: string }>) => void): void;
  showToastNotification?(options: Record<string, unknown>): unknown;
}

/* ------------------------------------------------------------ typed getters */

export function bb(): BBBlockbenchApi {
  return getGlobal<BBBlockbenchApi>('Blockbench');
}

export function project(): BBModelProject {
  const bbApi = bb();
  const current = bbApi.Project;
  if (!current || typeof current !== 'object') throw new NeedProjectError();
  return current as BBModelProject;
}

export function maybeProject(): BBModelProject | null {
  const current = bb()?.Project;
  return current && typeof current === 'object' ? (current as BBModelProject) : null;
}

export function format(): BBFormat {
  const current = bb().Format;
  if (!current || typeof current !== 'object') {
    throw new MissingApiError('Format', 'no model format is active');
  }
  return current as BBFormat;
}

export function maybeFormat(): BBFormat | null {
  const current = bb()?.Format;
  return current && typeof current === 'object' ? (current as BBFormat) : null;
}

export function undo(): BBUndoSystem {
  const current = project().undo;
  if (!current) throw new MissingApiError('UndoSystem', 'the active project has no undo system');
  return current;
}

export function outliner(): {
  root: BBNode[];
  elements: BBNode[];
  selected: BBNode[];
  updateAll(element?: unknown): void;
} {
  return getGlobal('Outliner');
}

export function cubeClass(): { new (data?: Record<string, unknown>, uuid?: string): BBCube; all: BBCube[]; properties: Record<string, unknown> } {
  return getGlobal('Cube');
}

export function groupClass(): { new (data?: Record<string, unknown>, uuid?: string): BBGroup; all: BBGroup[]; multi_selected: BBGroup[]; first_selected?: BBGroup; selected: BBGroup[] } {
  return getGlobal('Group');
}

export function textureClass(): {
  new (data?: Record<string, unknown>, uuid?: string): BBTexture;
  all: BBTexture[];
  selected?: BBTexture;
} {
  return getGlobal('Texture');
}

export function animationClass(): { new (data?: Record<string, unknown>): BBAnimation; all?: BBAnimation[] } {
  return getGlobal('Animation');
}

export function keyframeClass(): { new (data?: Record<string, unknown>, uuid?: string, animator?: BBAnimator): BBKeyframe } {
  return getGlobal('Keyframe');
}

export function animatorRegistry(): { animations: BBAnimation[]; selected?: unknown } {
  return getGlobal('Animator');
}

export function timeline(): { time: number; setTime(time: number): void; playing?: boolean; [key: string]: unknown } {
  return getGlobal('Timeline');
}

export function canvasApi(): {
  updateAll(): void;
  updateAllBones(bones?: unknown): void;
  updateAllFaces(texture?: unknown): void;
  updateAllUVs(): void;
  updatePositions(leave_selection?: boolean): void;
  withoutGizmos(cb: () => void): void;
  getModelBoundingBox(): unknown;
  getModelSize(): number[] | null;
  getSelectionBounds(): unknown;
} {
  return getGlobal('Canvas');
}

export function previewApi(): {
  selected: BBPreview | null;
  all: BBPreview[];
} {
  return getGlobal('Preview');
}

export function screencam(): BBScreencam {
  return getGlobal('Screencam');
}

export function codecs(): { project: { compile(options?: Record<string, unknown>): Record<string, unknown>; parse(model: unknown, path?: string): unknown; load(model: unknown, file?: unknown): unknown; export(): unknown } } {
  return getGlobal('Codecs');
}

export function modeManager(): { id: string | null; selected?: unknown; all?: unknown[] } {
  return getGlobal('Modes');
}

export function settingsApi(): { get(id: string): unknown } {
  return getGlobal('Settings');
}

export function panelsApi(): Record<string, unknown> {
  return getGlobal('Panels');
}

/** Global constructor/factory list the plugin relies on, used for capability probing. */
export const REQUIRED_GLOBALS = [
  'Blockbench',
  'Outliner',
  'Cube',
  'Group',
  'Texture',
  'Animation',
  'Keyframe',
  'Animator',
  'Timeline',
  'Canvas',
  'Preview',
  'Screencam',
  'Codecs',
  'Settings',
  'Panels',
  'Prop',
] as const;

/** Adds a global to the check list without failing when the format does not support it. */
export const OPTIONAL_GLOBALS = ['Mesh', 'Locator', 'NullObject', 'TextureMesh', 'SplineMesh', 'Modes', 'BarItems', 'UndoSystem'] as const;
