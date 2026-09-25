/** Assembles every tool module into one registry. */

import { ToolRegistry } from './registry.js';
import { inspectTools } from './inspect.js';
import { geometryTools } from './geometry.js';
import { animationTools } from './animation.js';
import { textureTools } from './texture.js';
import { visualTools } from './visual.js';
import { projectTools } from './project.js';
import { scriptTools } from './script.js';

export interface RegistryOptions {
  /** Whether `run_script` is allowed (plugin setting). */
  isScriptEnabled: () => boolean;
}

export function buildRegistry(options: RegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    ...inspectTools(),
    ...geometryTools(),
    ...animationTools(),
    ...textureTools(),
    ...visualTools(),
    ...projectTools(),
    ...scriptTools(options.isScriptEnabled),
  ]) {
    registry.register(tool);
  }
  return registry;
}

export { ToolRegistry } from './registry.js';
export type { RegisteredTool, ToolContext, ToolOutput } from './registry.js';
