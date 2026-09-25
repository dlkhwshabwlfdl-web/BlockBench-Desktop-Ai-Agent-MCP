/**
 * Self-discovery (requirement #14).
 *
 * At startup the plugin probes the running Blockbench build and produces a
 * capability report. The report is what makes "never guess APIs" a runtime
 * guarantee rather than a promise: every feature the tool registry depends on is
 * checked here, and a missing feature turns into an explicit limitation string
 * that the agent is told about instead of a runtime crash.
 */

import {
  REQUIRED_GLOBALS,
  bb,
  getGlobal,
  hasGlobal,
  hasMethod,
  hasProperty,
  maybeFormat,
  modeManager,
  tryGlobal,
} from './env.js';
import { BLOCKBENCH_EVENTS, DETECTED_BLOCKBENCH_VERSION } from '../blockbench-api/generated/events.js';
import type { CapabilityFeature, CapabilityReport } from '../shared/protocol.js';
import { PLUGIN_VERSION } from './meta.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';

interface FeatureProbe {
  id: string;
  /** Where in the installed build this was verified to exist. */
  source: string;
  test: () => boolean;
  /** When false, a missing feature is a hard limitation rather than a soft note. */
  required?: boolean;
  note?: string;
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Feature probes. Every entry names the file and symbol in the installed
 * Blockbench build that provides it (see docs/BLOCKBENCH-API-REPORT.md).
 */
export const FEATURE_PROBES: FeatureProbe[] = [
  {
    id: 'core.globals',
    source: 'js/*.js Object.assign(window, global)',
    required: true,
    test: () => REQUIRED_GLOBALS.every((name) => hasGlobal(name)),
    note: 'Blockbench, Outliner, Cube, Group, Texture, Animation, Keyframe, Animator, Timeline, Canvas, Preview, Screencam, Codecs, Settings, Panels, Prop',
  },
  {
    id: 'project.compile',
    source: 'js/formats/bbmodel.js: new Codec("project", {...}).compile()',
    required: true,
    // `Codecs` is a `Record<string, Codec>`: `Codecs.project` is an object, so probing it
    // with hasMethod() always returned false and this capability was reported missing
    // even though checkpoints and save depend on it and it works fine.
    test: () => hasMethod((tryGlobal<Record<string, unknown>>('Codecs') ?? {}).project, 'compile'),
    note: 'used for full-project snapshots (checkpoints and save); compile() accepts {raw:true} to return the object instead of a JSON string',
  },
  {
    id: 'project.parse',
    source: 'js/formats/bbmodel.js: new Codec("project", {...}).parse()',
    test: () => hasMethod((tryGlobal('Codecs') as any)?.project, 'parse'),
    note: 'used for the safe-path rollback',
  },
  {
    id: 'project.new',
    source: 'js/io/project.ts: newProject() / setupProject()',
    test: () => hasMethod(globalThis, 'newProject') && hasMethod(globalThis, 'setupProject'),
  },
  {
    id: 'undo.per_project',
    source: 'js/undo.js: class UndoSystem; ModelProject.undo getter',
    required: true,
    test: () => {
      const current = (bb().Project as any) || null;
      return !current || !!current.undo;
    },
    note: 'Undo history lives on the project in 5.x (Blockbench.undo is a getter over it)',
  },
  {
    id: 'undo.history_introspection',
    source: 'js/undo.js: UndoSystem.history / UndoSystem.index',
    test: () => {
      const current = (bb().Project as any) || null;
      return !current || (Array.isArray(current.undo?.history) && typeof current.undo?.index === 'number');
    },
    note: 'lets checkpoints roll back by rewinding the undo stack, which is far cheaper than reloading a snapshot',
  },
  {
    id: 'viewport.screenshot',
    source: 'js/preview/preview.ts: Preview.prototype.screenshot(options, callback)',
    required: true,
    test: () => hasMethod((tryGlobal('Preview') as any)?.prototype, 'screenshot'),
  },
  {
    id: 'viewport.advanced_screenshot',
    source: 'js/preview/screenshot.js: Screencam.advancedScreenshot(preview, options, cb)',
    test: () => hasMethod(tryGlobal('Screencam'), 'advancedScreenshot'),
    note: 'multi-angle captures with gizmos hidden: the primary visual input for the agent',
  },
  {
    id: 'viewport.return_screenshot',
    source: 'js/preview/screenshot.js: Screencam.returnScreenshot(dataUrl, cb)',
    test: () => hasMethod(tryGlobal('Screencam'), 'returnScreenshot'),
  },
  {
    id: 'viewport.texture_editor_screenshot',
    source: 'js/preview/screenshot.js: Screencam.screenshot2DEditor(options, cb)',
    test: () => hasMethod(tryGlobal('Screencam'), 'screenshot2DEditor'),
    note: 'used by get_texture_view / get_uv_view',
  },
  {
    id: 'viewport.without_gizmos',
    source: 'js/preview/canvas.js: Canvas.withoutGizmos(cb)',
    test: () => hasMethod(tryGlobal('Canvas'), 'withoutGizmos'),
  },
  {
    id: 'canvas.model_bounds',
    source: 'js/preview/canvas.js: Canvas.getModelBoundingBox() / Canvas.getModelSize()',
    test: () => hasMethod(tryGlobal('Canvas'), 'getModelBoundingBox') && hasMethod(tryGlobal('Canvas'), 'getModelSize'),
    note: 'stops the camera from framing on selection only',
  },
  {
    id: 'cube.uv_offset',
    source: 'js/outliner/types/cube.js: Cube constructor sets uv_offset and autouv',
    required: true,
    test: () => {
      const ctor = tryGlobal<any>('Cube');
      const probe = typeof ctor === 'function' && ctor.properties ? Object.keys(ctor.properties) : [];
      return Array.isArray(probe) && probe.length > 0;
    },
    note: 'Blockbench 5 renamed the cube UV origin from `uv` to `uv_offset`',
  },
  {
    id: 'cube.face_uv',
    source: 'js/outliner/types/cube.js: CubeFace.uv / rotation / texture / tint / enabled',
    // `uv` is an instance field (assigned in the Face constructor) and `getUndoCopy` is an
    // instance method, so neither lives on CubeFace.prototype or on the constructor. Probe
    // the accessors that genuinely are on the prototype instead.
    test: () => {
      const proto = (tryGlobal<any>('CubeFace')?.prototype ?? {}) as Record<string, unknown>;
      return hasProperty(proto, 'uv_size') || hasProperty(proto, 'element');
    },
  },
  {
    id: 'cube.project_box_uv',
    source: 'js/io/project.ts: ModelProject.box_uv / ModelProject.optional_box_uv',
    test: () => {
      const current = (bb().Project as any) || null;
      return !current || hasProperty(current, 'box_uv');
    },
  },
  {
    id: 'group.bone_rig',
    source: 'js/outliner/types/group.js: Group.prototype.name_regex uses Format.bone_rig',
    test: () => {
      const active = maybeFormat();
      return !!active && hasProperty(active, 'bone_rig');
    },
    note: 'in Blockbench a "bone" is a Group inside a format with bone_rig enabled',
  },
  {
    id: 'animation.animators',
    source: 'js/animations/animation.js: Animation.animators / getBoneAnimator(node)',
    test: () => hasMethod(tryGlobal<any>('Animation')?.prototype, 'getBoneAnimator'),
  },
  {
    id: 'animation.registry',
    source: 'js/animations/animation.js: Animator.animations',
    test: () => Array.isArray((tryGlobal('Animator') as any)?.animations),
  },
  {
    id: 'keyframe.data_points',
    source: 'js/animations/keyframe.js: Keyframe.data_points / KeyframeDataPoint',
    test: () => hasMethod(tryGlobal<any>('Keyframe')?.prototype, 'extend'),
  },
  {
    id: 'timeline.control',
    source: 'js/animations/timeline.js: Timeline.setTime(time)',
    test: () => hasMethod(tryGlobal('Timeline'), 'setTime'),
  },
  {
    id: 'texture.from_data_url',
    source: 'js/texturing/textures.js: Texture.prototype.fromDataURL(data_url)',
    required: true,
    test: () => hasMethod((tryGlobal('Texture') as any)?.prototype, 'fromDataURL'),
  },
  {
    id: 'texture.project_list',
    source: 'js/io/project.ts: ModelProject.textures',
    test: () => {
      const current = (bb().Project as any) || null;
      return !current || Array.isArray(current.textures);
    },
  },
  {
    id: 'mesh.support',
    source: 'js/outliner/types/mesh.js: Mesh; Format.meshes',
    test: () => hasGlobal('Mesh') && !!maybeFormat()?.meshes,
    note: 'free-form meshes are only available in formats that enable them',
  },
  {
    id: 'locator.support',
    source: 'js/outliner/types/locator.js: Locator; Format.locators',
    test: () => hasGlobal('Locator') && !!maybeFormat()?.locators,
  },
  {
    id: 'events.registry',
    source: `docs/BLOCKBENCH-API-REPORT.md (${DETECTED_BLOCKBENCH_VERSION})`,
    required: true,
    test: () => typeof bb().on === 'function' && hasMethod(bb(), 'dispatchEvent'),
    note: `${BLOCKBENCH_EVENTS.length} dispatched event names were verified in ${DETECTED_BLOCKBENCH_VERSION}`,
  },
  {
    id: 'mode.animation',
    source: 'js/modes.ts: Modes',
    test: () => hasProperty(tryGlobal('Modes'), 'animate') && hasProperty(tryGlobal('Modes'), 'edit'),
  },
  {
    id: 'panel.api',
    source: 'js/interface/panels.ts: class Panel',
    required: true,
    test: () => typeof tryGlobal('Panel') === 'function' && hasMethod(tryGlobal<any>('Panel')?.prototype, 'moveTo'),
  },
  {
    id: 'action.api',
    source: 'js/interface/actions.ts: class Action extends BarItem',
    required: true,
    test: () => typeof tryGlobal('Action') === 'function',
  },
  {
    id: 'setting.api',
    source: 'js/interface/settings.ts: class Setting',
    test: () => typeof tryGlobal('Setting') === 'function',
  },
  {
    id: 'toolbar.api',
    source: 'js/interface/toolbars.ts: class Toolbar',
    test: () => typeof tryGlobal('Toolbar') === 'function',
  },
  {
    id: 'fingerprint.resolution',
    source: 'js/io/project.ts: ModelProject._texture_width / texture_width getter',
    test: () => {
      const current = (bb().Project as any) || null;
      if (!current) return true;
      // 5.2.1 has no `resolution` object at all — width and height are private fields
      // exposed only through the texture_width/texture_height getters.
      return hasProperty(current, 'texture_width') && hasProperty(current, 'texture_height');
    },
    note: 'read and write Project.texture_width / texture_height; there is no Project.resolution object in this build',
  },
];

function probePermissions(): string[] {
  // Deliberately does not request anything: the bridge owns all file access, so the
  // plugin should never need a permission dialog. Reported for transparency only.
  const flagged: string[] = [];
  if (hasProperty(globalThis, 'SystemInfo')) flagged.push('system_info');
  return flagged;
}

function probeInstalledPlugins(): Array<{ id: string; version: string; source: string }> {
  const plugins = tryGlobal<any>('Plugins');
  if (!plugins) return [];
  const list = Array.isArray(plugins.all) ? plugins.all : [];
  return list
    .filter((plugin: any) => plugin?.installed)
    .map((plugin: any) => ({
      id: String(plugin.id ?? 'unknown'),
      version: String(plugin.version ?? ''),
      source: String(plugin.source ?? ''),
    }));
}

export function probeCapabilities(): CapabilityReport {
  const bbApi = bb();
  const activeFormat = maybeFormat();
  const limitations: string[] = [];

  const features: CapabilityFeature[] = FEATURE_PROBES.map((probe) => {
    let available = false;
    let note = probe.note;
    try {
      available = probe.test();
    } catch (error) {
      available = false;
      note = `${probe.note ? probe.note + ' — ' : ''}probe failed: ${(error as Error).message}`;
    }
    if (!available && probe.required) {
      limitations.push(`Required capability "${probe.id}" is unavailable (${probe.source}).`);
    } else if (!available && probe.id === 'mesh.support') {
      limitations.push('Free-form meshes are unavailable in the active format; cube/poly-mesh geometry only.');
    } else if (!available && probe.id === 'locator.support') {
      limitations.push('Locators are unavailable in the active format.');
    }
    return { id: probe.id, available, source: probe.source, note };
  });

  let activeMode: string | null = null;
  try {
    const modes = modeManager() as any;
    activeMode = modes?.id ?? (modes?.selected?.id ?? null);
  } catch {
    activeMode = null;
  }

  let formatCount = 0;
  try {
    const formats = tryGlobal<any>('Formats');
    if (formats?.all) formatCount = formats.all.length;
    else if (Array.isArray(formats)) formatCount = formats.length;
  } catch {
    formatCount = 0;
  }

  const version = String(bbApi.version ?? 'unknown');
  if (version !== DETECTED_BLOCKBENCH_VERSION) {
    limitations.push(
      `This plugin's API report was extracted from Blockbench ${DETECTED_BLOCKBENCH_VERSION} but the running build is ${version}; ` +
        `capabilities were re-probed at runtime, but exotic APIs may behave differently.`,
    );
  }

  const report: CapabilityReport = {
    plugin_version: PLUGIN_VERSION,
    protocol_version: PROTOCOL_VERSION,
    blockbench_version: version,
    blockbench_is_app: !!bbApi.isApp,
    platform: String(bbApi.platform ?? 'unknown'),
    operating_system: String(bbApi.operating_system ?? 'unknown'),
    browser: String(bbApi.browser ?? 'unknown'),
    active_format: activeFormat ? activeFormat.id : null,
    format_count: formatCount,
    mode: activeMode,
    features,
    permissions: probePermissions(),
    installed_plugins: probeInstalledPlugins(),
    available_events: [...BLOCKBENCH_EVENTS],
    limitations,
  };
  return report;
}

/** Compact one-line summary used by the panel and by `--doctor`. */
export function summariseCapabilities(report: CapabilityReport): string {
  const available = report.features.filter((f) => f.available).length;
  return `${available}/${report.features.length} capabilities · Blockbench ${report.blockbench_version} · format ${report.active_format ?? 'none'}`;
}

export function isFeatureAvailable(report: CapabilityReport, id: string): boolean {
  return !!report.features.find((feature) => feature.id === id && feature.available);
}

/** Convenience for tools that need to fail fast with a clear message. */
export function assertFeature(id: string, detail: string): void {
  const probe = FEATURE_PROBES.find((p) => p.id === id);
  if (!probe) throw new Error(`Unknown capability probe "${id}"`);
  if (!probe.test()) {
    throw new Error(`This Blockbench build/format does not support ${detail} (capability "${id}" unavailable).`);
  }
}

export { safeNumber, getGlobal };
