/**
 * Visual understanding (requirement #3).
 *
 * The agent gets real pixels, not a description of pixels. Every capture goes
 * through Blockbench's own screenshot machinery, which was read out of the
 * installed build before this file was written:
 *
 *   - `Screencam.advancedScreenshot(preview, options, cb)`
 *       js/preview/screenshot.js: renders into an *offscreen* preview
 *       (`MediaPreview` for MSAA, `Screencam.NoAAPreview` otherwise), so the user's
 *       viewport is never disturbed by an agent capture.
 *   - `Screencam.screenshotPreview(preview, {crop,width,height}, cb)`
 *       js/preview/screenshot.js: crops the live viewport canvas.
 *   - `Screencam.screenshot2DEditor({width,height}, cb)`
 *       js/preview/screenshot.js: captures the 2D texture/UV editor canvas.
 *
 * Nothing here fakes a screenshot. If the machinery is missing the caller gets a
 * thrown error naming the missing API, which the capability report already
 * surfaces as a limitation.
 */

import { canvasApi, cubeClass, previewApi, screencam, tryGlobal, type BBPreview } from './env.js';

export type AntiAliasing = 'off' | 'msaa' | 'ssaa';

export interface ViewportImage {
  /** Camera preset used, or "view" for the live viewport. */
  angle: string;
  data_url: string;
  width: number;
  height: number;
  bytes: number;
}

export interface CaptureOptions {
  resolution?: number;
  anti_aliasing?: AntiAliasing;
  shading?: boolean;
  zoom?: number;
  timeout_ms?: number;
}

export const ANGLE_PRESETS = [
  'initial',
  'top',
  'bottom',
  'south',
  'north',
  'east',
  'west',
  'isometric_right',
  'isometric_left',
  'true_isometric_right',
  'true_isometric_left',
] as const;

export type AnglePresetId = (typeof ANGLE_PRESETS)[number] | 'view';

/** The viewpoints that give the agent the best read on a Minecraft-style model. */
export const DEFAULT_SNAPSHOT_ANGLES: AnglePresetId[] = [
  'view',
  'north',
  'east',
  'top',
  'isometric_right',
  'isometric_left',
];

/** Presets that actually exist right now (Blockbench formats can push extra ones). */
export function availableAnglePresets(): string[] {
  const presets = tryGlobal<Array<{ id: string }>>('DefaultCameraPresets');
  if (Array.isArray(presets)) return presets.map((preset) => String(preset.id)).filter(Boolean);
  return [...ANGLE_PRESETS];
}

function presetExists(id: string): boolean {
  if (id === 'view') return true;
  return availableAnglePresets().includes(id);
}

function selectedPreview(): BBPreview {
  const api = previewApi();
  const preview = api?.selected;
  if (!preview) throw new Error('No preview viewport is available; open a project and bring a viewport into focus.');
  return preview;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * PNG dimensions are read straight out of the IHDR chunk. Doing it here keeps the
 * payload honest: the bridge can trust the numbers without decoding the image.
 */
function pngSize(dataUrl: string): { width: number; height: number } {
  const cached = dimensionsCache.get(dataUrl);
  if (cached) return cached;
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return { width: 0, height: 0 };
    const binary = atob(dataUrl.slice(comma + 1).slice(0, 128));
    // PNG signature is 8 bytes, then length(4) + 'IHDR'(4), then width/height.
    if (binary.slice(12, 16) !== 'IHDR') return { width: 0, height: 0 };
    const view = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 8; i++) view.setUint8(i, binary.charCodeAt(16 + i));
    const size = { width: view.getUint32(0), height: view.getUint32(4) };
    dimensionsCache.set(dataUrl, size);
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

function base64PayloadLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const length = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

const dimensionsCache = new Map<string, { width: number; height: number }>();

function toImage(angle: string, dataUrl: string): ViewportImage {
  const size = pngSize(dataUrl);
  return {
    angle,
    data_url: dataUrl,
    width: size.width,
    height: size.height,
    bytes: base64PayloadLength(dataUrl),
  };
}

/**
 * Capture one camera angle offscreen.
 *
 * `advancedScreenshot` reads `options.resolution[0]` unconditionally, so a
 * resolution is always supplied.
 */
export function captureAngle(angle: AnglePresetId, options: CaptureOptions = {}): Promise<ViewportImage> {
  const preview = selectedPreview();
  const resolution = options.resolution ?? 640;
  const preset = presetExists(angle) ? angle : 'view';
  const requested = options.anti_aliasing ?? 'msaa';
  const antiAliasing: AntiAliasing =
    requested === 'msaa' && !tryGlobal('MediaPreview') ? 'off' : requested === 'ssaa' && !tryGlobal('MediaPreview') ? 'off' : requested;

  return withTimeout(
    new Promise<ViewportImage>((resolve, reject) => {
      try {
        screencam().advancedScreenshot(
          preview,
          {
            resolution: [resolution, resolution],
            angle_preset: preset,
            zoom: options.zoom ?? 0,
            anti_aliasing: antiAliasing,
            show_gizmos: false,
            shading: options.shading ?? true,
            show_errors: false,
          },
          (dataUrl: string) => {
            if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
              reject(new Error('advancedScreenshot did not return an image data URL'));
              return;
            }
            resolve(toImage(preset, dataUrl));
          },
        );
      } catch (error) {
        reject(error);
      }
    }),
    options.timeout_ms ?? 25000,
    `viewport capture (${preset})`,
  );
}

/** Multi-angle contact sheet source: one clean render per requested viewpoint. */
export async function captureAngles(
  angles: AnglePresetId[] = DEFAULT_SNAPSHOT_ANGLES,
  options: CaptureOptions = {},
  onProgress?: (step: number, total: number, label: string) => void,
): Promise<ViewportImage[]> {
  const images: ViewportImage[] = [];
  const unique: AnglePresetId[] = [];
  for (const angle of angles) {
    const resolved = presetExists(angle) ? angle : 'view';
    if (!unique.includes(resolved)) unique.push(resolved);
  }
  for (let i = 0; i < unique.length; i++) {
    onProgress?.(i + 1, unique.length, `capturing ${unique[i]}`);
    images.push(await captureAngle(unique[i], options));
    // Give the renderer a frame between captures; several captures back to back in
    // one task starve the compositor and produce blank frames.
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return images;
}

/** Crop of the live viewport, exactly as the user sees it. */
export function captureLiveViewport(options: { width?: number; height?: number } = {}): Promise<ViewportImage> {
  const preview = selectedPreview();
  return withTimeout(
    new Promise<ViewportImage>((resolve, reject) => {
      try {
        preview.screenshot({ crop: true, width: options.width ?? 640, height: options.height ?? 640 }, (dataUrl: string) => {
          try {
            resolve(toImage('view', dataUrl));
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    }),
    20000,
    'live viewport capture',
  );
}

/** The 2D texture/UV editor canvas. */
export function captureTextureEditor(options: { width?: number; height?: number } = {}): Promise<ViewportImage> {
  return withTimeout(
    new Promise<ViewportImage>((resolve, reject) => {
      try {
        screencam().screenshot2DEditor({ width: options.width, height: options.height }, (dataUrl: string) => {
          if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
            reject(new Error('screenshot2DEditor did not return an image data URL'));
            return;
          }
          resolve(toImage('2d_editor', dataUrl));
        });
      } catch (error) {
        reject(error);
      }
    }),
    20000,
    'texture editor capture',
  );
}

interface Bounds {
  min: number[];
  max: number[];
}

/** Read a THREE.Box3-ish value without importing three.js. */
function readBox(value: unknown): Bounds | null {
  const box = value as { min?: { x?: number; y?: number; z?: number }; max?: { x?: number; y?: number; z?: number }; isEmpty?: () => boolean };
  if (!box || typeof box !== 'object') return null;
  const { min, max } = box;
  if (!min || !max) return null;
  const nums = [min.x, min.y, min.z, max.x, max.y, max.z];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  if (box.isEmpty?.() === true) return null;
  return { min: [min.x as number, min.y as number, min.z as number], max: [max.x as number, max.y as number, max.z as number] };
}

/** The model's world bounds, preferring Blockbench's own calculation. */
function modelBounds(selection: boolean): Bounds | null {
  const canvas = canvasApi() as unknown as { getSelectionBounds?: () => unknown; getModelBoundingBox?: () => unknown };
  if (selection && typeof canvas.getSelectionBounds === 'function') {
    const box = readBox(canvas.getSelectionBounds());
    if (box) return box;
  }
  if (typeof canvas.getModelBoundingBox === 'function') {
    const box = readBox(canvas.getModelBoundingBox());
    if (box) return box;
  }
  // Fall back to the cube list, so framing still works if Canvas is unavailable.
  let cubes: Array<{ from: number[]; to: number[]; visibility?: boolean }> = [];
  try {
    cubes = (cubeClass().all ?? []) as unknown as typeof cubes;
  } catch {
    cubes = [];
  }
  const visible = cubes.filter((cube) => cube && cube.visibility !== false && Array.isArray(cube.from) && Array.isArray(cube.to));
  if (!visible.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const cube of visible) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], cube.from[i], cube.to[i]);
      max[i] = Math.max(max[i], cube.from[i], cube.to[i]);
    }
  }
  return { min, max };
}

export interface FrameOptions {
  angle?: AnglePresetId;
  /** Fraction of the frame the model should occupy. 0.85 leaves a comfortable margin. */
  padding?: number;
  /** Frame the current selection rather than the whole model. */
  selection?: boolean;
  /** Keep the current viewing direction; only recentre and fit. */
  keep_angle?: boolean;
}

export interface FrameResult {
  angle: string;
  projection: 'orthographic' | 'perspective';
  target: number[];
  camera_position: number[];
  bounds: Bounds;
  size: number[];
  zoom: number | null;
  distance: number | null;
}

/**
 * Point the viewport at the model and zoom so the whole thing fits.
 *
 * Camera presets in Blockbench are written for a 16-unit Minecraft block sitting on
 * the origin: every orthographic direction preset targets (0,0,0). A rig this size is
 * ~106 units long with its feet on y = 0, so the presets alone leave most of it out of
 * frame. This recentres on the real bounding box, keeps the preset's viewing
 * direction, then solves for the orthographic zoom (or perspective distance) that
 * makes the box fill `padding` of the frame.
 *
 * Used with `get_viewport_image { angle: "view" }`, which copies this camera into an
 * offscreen render, so the capture matches exactly what was framed here.
 */
export function frameViewport(options: FrameOptions = {}): FrameResult {
  const preview = selectedPreview() as unknown as FrameablePreview;

  if (typeof preview.loadAnglePreset === 'function' && !options.keep_angle) {
    const angle = options.angle && options.angle !== 'view' ? options.angle : 'initial';
    const presets = tryGlobal<Array<Record<string, unknown>>>('DefaultCameraPresets') ?? [];
    const preset = presets.find((entry) => String(entry.id) === angle);
    if (!preset) throw new Error(`Unknown camera preset "${angle}". Available: ${availableAnglePresets().join(', ')}`);
    preview.loadAnglePreset(preset);
  }

  const bounds = modelBounds(options.selection === true);
  if (!bounds) throw new Error('Nothing to frame — the project has no visible geometry.');
  const padding = Math.min(0.98, Math.max(0.3, options.padding ?? 0.86));
  const centre = [0, 1, 2].map((i) => (bounds.min[i] + bounds.max[i]) / 2);
  const size = [0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]);

  const Vec = (preview.camera.position as unknown as { constructor: new (x: number, y: number, z: number) => AnyVec3 }).constructor;
  const target = preview.controls.target;
  const oldTarget = { x: target.x, y: target.y, z: target.z };

  // Extents along the camera's own axes, measured about the new centre.
  const q = preview.camera.quaternion;
  const axis = (x: number, y: number, z: number): AnyVec3 => new Vec(x, y, z).applyQuaternion(q);
  const right = axis(1, 0, 0);
  const up = axis(0, 1, 0);
  const forward = axis(0, 0, 1);
  let maxU = 0;
  let maxV = 0;
  for (let corner = 0; corner < 8; corner++) {
    const cornerWorld = [0, 1, 2].map((i) => (corner & (1 << i) ? bounds.max[i] : bounds.min[i]) - centre[i]);
    const dot = (a: AnyVec3) => a.x * cornerWorld[0] + a.y * cornerWorld[1] + a.z * cornerWorld[2];
    maxU = Math.max(maxU, Math.abs(dot(right)));
    maxV = Math.max(maxV, Math.abs(dot(up)));
  }
  maxU = Math.max(maxU, 0.5);
  maxV = Math.max(maxV, 0.5);

  // Recentre: move the orbit target and carry the camera along by the same delta so
  // the viewing direction is untouched.
  target.set(centre[0], centre[1], centre[2]);
  const camera = preview.camera;
  camera.position.set(
    camera.position.x + (centre[0] - oldTarget.x),
    camera.position.y + (centre[1] - oldTarget.y),
    camera.position.z + (centre[2] - oldTarget.z),
  );

  let zoom: number | null = null;
  let distance: number | null = null;
  if (preview.isOrtho) {
    const ortho = preview.camOrtho;
    const frameWidth = Math.abs(ortho.right - ortho.left);
    const frameHeight = Math.abs(ortho.top - ortho.bottom);
    // The offscreen capture is always square, and `MediaPreview.copyView` rescales the
    // orthographic bounds by `ratio / current_ratio` to get there. Working that through:
    // the render ends up showing `min(frameWidth, frameHeight) / zoom` world units in
    // BOTH axes, not the live viewport's own extents. Fitting against frameWidth instead
    // is what cropped the tail off a 106-unit model in a 16:9 viewport.
    const side = Math.min(frameWidth, frameHeight);
    zoom = (side * padding) / (2 * Math.max(maxU, maxV));
    if (Number.isFinite(zoom) && zoom > 0) {
      ortho.zoom = zoom;
      if (typeof ortho.updateProjectionMatrix === 'function') ortho.updateProjectionMatrix();
      else camera.updateProjectionMatrix?.();
    } else {
      zoom = null;
    }
  } else {
    const fov = (preview.camPers?.fov ?? 70) * (Math.PI / 180);
    const tan = Math.tan(fov / 2);
    const aspect = Math.abs((preview as unknown as { width: number }).width / (preview as unknown as { height: number }).height) || 1;
    distance = Math.max(maxV / (tan * padding), maxU / (tan * padding * aspect));
    const offset = new Vec(camera.position.x - oldTarget.x, camera.position.y - oldTarget.y, camera.position.z - oldTarget.z);
    const length = Math.hypot(offset.x, offset.y, offset.z);
    // Keep the preset's viewing direction; fall back to the camera's own forward axis
    // when the camera sat exactly on the old target and has no usable offset.
    const dir = length < 1e-6 ? forward : new Vec(offset.x / length, offset.y / length, offset.z / length);
    camera.position.set(
      centre[0] + dir.x * distance,
      centre[1] + dir.y * distance,
      centre[2] + dir.z * distance,
    );
  }

  preview.controls.update?.();
  try {
    canvasApi().updateAll();
  } catch {
    /* updating the canvas is best effort */
  }

  return {
    angle: options.keep_angle ? 'kept' : String(options.angle ?? 'initial'),
    projection: preview.isOrtho ? 'orthographic' : 'perspective',
    target: [target.x, target.y, target.z],
    camera_position: [camera.position.x, camera.position.y, camera.position.z],
    bounds,
    size,
    zoom,
    distance,
  };
}

interface AnyVec3 {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): AnyVec3;
  applyQuaternion(q: AnyQuat): AnyVec3;
}

interface AnyQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface AnyCamera {
  position: AnyVec3;
  quaternion: AnyQuat;
  updateProjectionMatrix?: () => void;
}

/** The subset of Blockbench's `Preview` that framing needs. */
interface FrameablePreview {
  loadAnglePreset?(preset: unknown): unknown;
  isOrtho?: boolean;
  width: number;
  height: number;
  controls: { target: AnyVec3; update?: () => void };
  camera: AnyCamera;
  camOrtho: { left: number; right: number; top: number; bottom: number; zoom: number; updateProjectionMatrix?: () => void };
  camPers: { fov: number };
}

/**
 * Move the user's viewport to a viewpoint.
 *
 * Uses `Preview.prototype.loadAnglePreset(preset)` (js/preview/preview.ts), which is
 * the same call Blockbench's own camera menu makes, plus the orthographic zoom the
 * preset carries.
 */
export function focusViewport(angle: AnglePresetId, zoom?: number): { angle: string; camera_position: number[]; target: number[] } {
  const preview = selectedPreview() as BBPreview & {
    loadAnglePreset(preset: unknown): unknown;
    isOrtho?: boolean;
  };
  const presets = tryGlobal<Array<Record<string, unknown>>>('DefaultCameraPresets') ?? [];
  const preset = angle === 'view' ? presets[0] : presets.find((entry) => String(entry.id) === angle);
  if (!preset) {
    throw new Error(`Unknown camera preset "${angle}". Available: ${availableAnglePresets().join(', ')}`);
  }
  if (typeof preview.loadAnglePreset !== 'function') {
    throw new Error('Preview.loadAnglePreset is unavailable in this Blockbench build.');
  }
  preview.loadAnglePreset(preset);

  if (typeof zoom === 'number' && zoom > 0) {
    const camera = preview.camera as { zoom?: number; updateProjectionMatrix?: () => void };
    if (preview.isOrtho && camera && typeof camera.zoom === 'number') {
      camera.zoom = zoom;
      camera.updateProjectionMatrix?.();
    }
  }
  try {
    canvasApi().updateAll();
  } catch {
    /* updating the canvas is best effort */
  }

  const camera = preview.camera as { position?: { toArray(): number[] } } | undefined;
  const controls = preview.controls as { target?: { toArray(): number[] } } | undefined;
  return {
    angle: String(preset.id ?? angle),
    camera_position: camera?.position?.toArray?.() ?? [0, 0, 0],
    target: controls?.target?.toArray?.() ?? [0, 0, 0],
  };
}
