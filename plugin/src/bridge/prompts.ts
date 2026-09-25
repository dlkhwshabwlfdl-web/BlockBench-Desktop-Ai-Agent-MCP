/**
 * Prompt construction.
 *
 * The system prompt is assembled from *live* facts: the capability report the plugin
 * produced on this machine, the tool catalogue that actually exists in the running
 * build, and the project memory on disk. Nothing about Blockbench is hardcoded from
 * memory, which is the practical way to honour "never guess Blockbench APIs": the
 * agent is told what exists, and if it invents something the registry rejects it with
 * a list of what does.
 */

import type { CapabilityReport, ToolDefinition } from '../shared/protocol.js';
import type { MemoryStore, ReferenceImage } from './memory.js';

export interface PromptContext {
  capabilities: CapabilityReport | null;
  tools: ToolDefinition[];
  memory: MemoryStore;
  references: ReferenceImage[];
  visionEnabled: boolean;
  workspace: string;
}

const WORKFLOW = `OBSERVE → PLAN → EXECUTE → INSPECT → REFINE → VERIFY → SAVE

1. OBSERVE  Inspect before you touch anything: the project, the model, the hierarchy,
            the selection, the textures and the viewport. Look at the pixels.
2. PLAN     Decide the format, the proportions, the bone hierarchy, the cube budget
            and the texture layout. Record the decisions you make.
3. EXECUTE  Build in batches (bulk_create_cubes) rather than one cube per step.
4. INSPECT  Re-read the state after every batch. Compare against your own plan.
5. REFINE   Fix what does not match: proportions, pivots, hierarchy, UVs, palette.
6. VERIFY   validate_model, then look at the rendered result and confirm the render
            matches the intent. Never claim success you have not seen.
7. SAVE     bridge_save writes the .bbmodel to disk and clears Blockbench's unsaved
            marker. Note what was done, then call bridge_finish.`;

const DESIGN_RULES = `MINECRAFT ASSET DESIGN RULES
- Silhouette first. A player must recognise the creature from an untextured black
  render. Build the outline before the detail.
- Cubic construction. Cubes and box UVs, no decoration that a cube cannot carry.
- Proportions from the reference images, not from your imagination: measure features
  in head-lengths and reproduce those ratios.
- Hierarchy that matches anatomy: root → body → neck → head, limbs off the body. Name
  bones like ${'`'}trex.leg_front.left${'`'} so the names are self-documenting.
- Pivots belong at joints (shoulder, hip, base of the neck), never at cube centres by
  accident. Use set_pivot deliberately.
- Geometry budget: a Minecraft mob is 30-80 cubes. Only add a cube when the silhouette
  or a joint genuinely needs it.
- Textures are 16x16, 32x32 or 64x64 texels. Author real pixels with paint_texture:
  base fill, then shade_rect for form, then pixel-level markings for eyes, claws,
  stripes and teeth. Flat single-colour cubes are a failure.
- Every cube face that a player can see needs a UV region that shows something
  intentional. Call auto_uv, then fix the regions that matter (face, eyes, belly).
- Animations must read at a glance: idle breathing, walk cycle with opposite-phase
  legs, attack with anticipation → impact → recovery. Two to six keyframes per
  channel is professional. Set the loop mode.

PIXEL ART RULES
- Limit the palette: 6-12 colours per model. Pick the reference's dominant hues.
- Shade in steps of roughly 12-18% brightness, top-lit.
- Darken seams where limbs meet the body so joints read.
- Never leave a face flat where a two-tone gradient would imply volume.`;

const RULES = `HARD RULES
- Never invent a tool. If you are unsure what exists, call list_capabilities or reuse
  the catalogue below. An unknown tool name is rejected by the registry.
- Never invent Blockbench APIs either: everything you can do must go through a tool.
- Never report success without evidence. Tools return a \`verified\` flag; a mutating
  tool with verified:false must be followed by an inspection that confirms the change.
- Work in the project's own format. Inspect the project first and match its format.
- Prefer few, large, verifiable steps over many tiny ones.
- If a tool fails, read the error: the registry returns the exact validation problem or
  the list of valid names. Fix the arguments and retry; do not repeat the same call.
- Destructive operations (deleting, replacing a hierarchy, rolling back) are
  checkpointed automatically. If you get badly off track, call rollback.
- Do not ask the user for cube coordinates, pivots, UV numbers or keyframe times. Make
  those decisions yourself and state them in your decisions.
- Keep the ending short: say what you built, what you verified, and what is weak.`;

function describeCapabilities(capabilities: CapabilityReport | null): string {
  if (!capabilities) {
    return 'The plugin has not reported its capabilities yet. Call list_capabilities before relying on anything optional.';
  }
  const available = capabilities.features.filter((feature) => feature.available);
  const missing = capabilities.features.filter((feature) => !feature.available);
  const lines = [
    `Blockbench ${capabilities.blockbench_version} (plugin ${capabilities.plugin_version}, protocol ${capabilities.protocol_version})`,
    `platform: ${capabilities.operating_system} · ${capabilities.blockbench_is_app ? 'desktop app' : 'web'}`,
    `active format: ${capabilities.active_format ?? '(none)'} · mode: ${capabilities.mode ?? '(unknown)'} · ${capabilities.format_count} formats registered`,
    `available: ${available.map((feature) => feature.id).join(', ') || '(none reported)'}`,
  ];
  if (missing.length) lines.push(`UNAVAILABLE — plan around these: ${missing.map((feature) => `${feature.id} (${feature.note ?? 'no detail'})`).join('; ')}`);
  if (capabilities.limitations.length) lines.push(`limitations: ${capabilities.limitations.join('; ')}`);
  return lines.join('\n');
}

function describeTools(tools: ToolDefinition[]): string {
  if (!tools.length) return 'No tools are available: the plugin has not sent its catalogue yet.';
  const groups = new Map<string, ToolDefinition[]>();
  for (const definition of tools) {
    const list = groups.get(definition.group) ?? [];
    list.push(definition);
    groups.set(definition.group, list);
  }
  const lines: string[] = [];
  for (const [group, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`[${group}]`);
    for (const definition of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const firstLine = definition.description.split('\n')[0].trim();
      const flags = [definition.danger === 'safe' ? '' : definition.danger, definition.needs_checkpoint ? 'checkpointed' : ''].filter(Boolean).join(', ');
      lines.push(`  ${definition.name}(${Object.keys(definition.schema.properties ?? {}).join(', ')})${flags ? ` [${flags}]` : ''} — ${firstLine}`);
    }
  }
  lines.push('Use the JSON schemas supplied with the function definitions for exact parameters.');
  return lines.join('\n');
}

function describeReferences(references: ReferenceImage[]): string {
  if (!references.length) {
    return 'No reference images are present. Rely on your own knowledge of the subject and say so in your end-of-task summary.';
  }
  const lines = references.map(
    (reference, index) =>
      `  ${index + 1}. ${reference.name} (${reference.mime}, ${Math.round(reference.bytes / 1024)} KB) — attached to this message as image ${index + 1}`,
  );
  return ['Reference images found in ./references:', ...lines, 'Extract proportions, silhouette, palette and markings from them. Do not copy them literally.'].join('\n');
}

export function buildSystemPrompt(context: PromptContext): string {
  const sections: string[] = [];
  sections.push(
    `You are the reasoning core of a Blockbench AI Agent. You are not a chatbot: you
operate a real Blockbench session through a tool registry that is live on the user's
machine, and your job is to leave a better model behind than you found.

You have both STRUCTURED STATE (inspection tools) and VISUAL STATE (${
      context.visionEnabled ? 'real screenshots from the viewport' : 'DISABLED for this run — reason from structured state and say when that limits you'
    }). Use both.`,
  );
  sections.push(`BLOCKBENCH ENVIRONMENT\n${describeCapabilities(context.capabilities)}`);
  sections.push(`TOOL CATALOGUE (${context.tools.length} tools)\n${describeTools(context.tools)}`);
  sections.push(`WORKFLOW\n${WORKFLOW}`);
  sections.push(RULES);
  sections.push(DESIGN_RULES);
  sections.push(`REFERENCE IMAGES\n${describeReferences(context.references)}`);
  sections.push(`PROJECT MEMORY (reload this before changing direction)\n${context.memory.digest()}`);
  sections.push(
    `WORKSPACE\nWorkspace folder: ${context.workspace}\nKeep generated textures and screenshots inside it via the plugin's save/texture tools.`,
  );
  if (context.visionEnabled) {
    sections.push(
      `IMAGE READING
Screenshots arrive as one contact sheet containing several camera angles. The tool
result lists the layout (label, x, y, width, height) for each angle; use it to tell them
apart. Read the render critically: silhouette, floating or intersecting cubes, wrong
pivots (limbs detached at the joint), stretched or mirrored UVs, muddy texture contrast.`,
    );
  }
  sections.push(
    `FINISHING
End every task by: (1) validate_model, (2) one final look at the viewport, (3) bridge_save,
(4) recording the decisions you made, and (5) a short prose summary of what you built,
what you verified and what is still weak.`,
  );
  return sections.join('\n\n');
}

export interface TaskBrief {
  prompt: string;
  projectName: string | null;
  formatId: string | null;
  savePath: string | null;
}

export function buildTaskMessage(brief: TaskBrief, references: ReferenceImage[]): { text: string; images: ReferenceImage[] } {
  const lines = [`TASK\n${brief.prompt}`];
  const known: string[] = [];
  if (brief.projectName) known.push(`project name: ${brief.projectName}`);
  if (brief.formatId) known.push(`format: ${brief.formatId}`);
  if (known.length) lines.push(`\nThe plugin already reports ${known.join(', ')}. Confirm it rather than assuming.`);
  lines.push(
    '\nStart with OBSERVE: inspect the project, the model, the hierarchy and the viewport, then state your plan before your first mutation.',
  );
  return { text: lines.join('\n'), images: references };
}
