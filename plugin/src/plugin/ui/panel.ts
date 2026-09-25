/**
 * The Blockbench side UI (requirement #12).
 *
 * Deliberately thin: the panel shows connection and project state and offers the six
 * controls the brief asked for. All intelligence stays in the agent; this file never
 * makes a modelling decision. Built with plain DOM rather than a Vue component so
 * the plugin has no framework coupling and keeps working across Blockbench UI
 * refactors.
 */

import { getGlobal, tryGlobal } from '../env.js';
import { PLUGIN_TITLE } from '../meta.js';
import type { LinkStatus } from './../bridge-client.js';
import type { PluginStateSnapshot } from '../../shared/protocol.js';

export interface PanelCallbacks {
  observe(): void;
  ask(prompt: string): void;
  stop(): void;
  checkpoint(): void;
  rollback(): void;
  reconnect(url: string, token: string): void;
  disconnect(): void;
  setRealtime(enabled: boolean): void;
  openLogs(): void;
}

interface Ref<T extends HTMLElement> {
  node: T;
}

/** Wraps a DOM node so the reference table stays a plain object of stable handles. */
function ref<T extends HTMLElement>(node: T): Ref<T> {
  return { node };
}

const PANEL_CSS = `
.ai_agent_panel { display: flex; flex-direction: column; gap: 6px; padding: 6px; font-size: 12px; }
.ai_agent_panel .ai_row { display: flex; align-items: center; gap: 6px; }
.ai_agent_panel .ai_label { opacity: 0.65; min-width: 78px; }
.ai_agent_panel .ai_value { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai_agent_panel .ai_status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #c0392b; }
.ai_agent_panel .ai_status.connected { background: #2ecc71; }
.ai_agent_panel .ai_status.connecting { background: #f1c40f; }
.ai_agent_panel .ai_buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 4px; }
.ai_agent_panel button { padding: 4px 6px; border-radius: 3px; border: 1px solid var(--color-border, #444); background: var(--color-button, #333); color: inherit; cursor: pointer; }
.ai_agent_panel button:hover { background: var(--color-accent, #4a6fa5); }
.ai_agent_panel textarea { width: 100%; min-height: 48px; resize: vertical; background: var(--color-background, #222); color: inherit; border: 1px solid var(--color-border, #444); border-radius: 3px; padding: 4px; font-family: inherit; }
.ai_agent_panel input[type=text] { width: 100%; background: var(--color-background, #222); color: inherit; border: 1px solid var(--color-border, #444); border-radius: 3px; padding: 3px; }
.ai_agent_panel .ai_progress { height: 4px; background: #333; border-radius: 2px; overflow: hidden; }
.ai_agent_panel .ai_progress > div { height: 100%; width: 0%; background: #2ecc71; transition: width 120ms linear; }
.ai_agent_panel .ai_log { max-height: 96px; overflow: auto; font-family: monospace; font-size: 11px; opacity: 0.85; white-space: pre-wrap; }
.ai_agent_panel .ai_adv { border-top: 1px solid #444; margin-top: 4px; padding-top: 4px; display: none; }
.ai_agent_panel .ai_adv.open { display: block; }
`;

export class AgentPanel {
  readonly panel: { node: HTMLElement; delete(): void; moveTo(slot: string): void; show?(): void; hide?(): void };
  private readonly refs: {
    status: Ref<HTMLSpanElement>;
    connection: Ref<HTMLSpanElement>;
    project: Ref<HTMLSpanElement>;
    format: Ref<HTMLSpanElement>;
    animation: Ref<HTMLSpanElement>;
    selection: Ref<HTMLSpanElement>;
    counts: Ref<HTMLSpanElement>;
    progress: Ref<HTMLDivElement>;
    progressBar: Ref<HTMLDivElement>;
    log: Ref<HTMLDivElement>;
    prompt: Ref<HTMLTextAreaElement>;
    url: Ref<HTMLInputElement>;
    token: Ref<HTMLInputElement>;
    realtime: Ref<HTMLInputElement>;
    advanced: Ref<HTMLDivElement>;
  };
  private status: LinkStatus = 'disconnected';
  private statusDetail = '';
  private css?: { delete(): void };

  constructor(
    private readonly callbacks: PanelCallbacks,
    /** Toolbar instances to dock inside this panel (must be created before the panel). */
    private readonly toolbars: unknown[] = [],
  ) {
    this.css = tryGlobal<{ addCSS(css: string, layer?: string): { delete(): void } }>('Blockbench')?.addCSS(PANEL_CSS, 'plugin');

    const PanelCtor = getGlobal<new (options: Record<string, unknown>) => AgentPanel['panel']>('Panel');
    this.refs = {
      status: ref(el('span', { class: 'ai_status' })),
      connection: ref(el('span', { class: 'ai_value' })),
      project: ref(el('span', { class: 'ai_value' })),
      format: ref(el('span', { class: 'ai_value' })),
      animation: ref(el('span', { class: 'ai_value' })),
      selection: ref(el('span', { class: 'ai_value' })),
      counts: ref(el('span', { class: 'ai_value' })),
      progress: ref(el('div', { class: 'ai_progress' })),
      progressBar: ref(el('div')),
      log: ref(el('div', { class: 'ai_log' })),
      prompt: ref(el('textarea', { placeholder: 'Describe what to build, then press Ask Agent' })),
      url: ref(el('input', { type: 'text' })),
      token: ref(el('input', { type: 'text' })),
      realtime: ref(el('input', { type: 'checkbox' })),
      advanced: ref(el('div', { class: 'ai_adv' })),
    };
    this.refs.progress.node.append(this.refs.progressBar.node);

    const body = el('div', { class: 'ai_agent_panel' });
    body.append(
      row('AI Agent', this.refs.status.node, this.refs.connection.node),
      row('Project', this.refs.project.node),
      row('Format', this.refs.format.node),
      row('Animation', this.refs.animation.node),
      row('Selection', this.refs.selection.node),
      row('Counts', this.refs.counts.node),
      this.refs.progress.node,
      this.refs.prompt.node,
      this.buttons(),
      this.refs.log.node,
      this.advancedSection(),
    );

    this.panel = new PanelCtor({
      id: 'ai_agent',
      name: PLUGIN_TITLE,
      icon: 'smart_toy',
      growable: true,
      resizable: true,
      toolbars: this.toolbars,
      default_position: { slot: 'right_bar', height: 340, float_position: [0, 0] },
      plugin: 'blockbench_ai_agent',
    });
    this.panel.node.append(body);
  }

  private buttons(): HTMLElement {
    const wrap = el('div', { class: 'ai_buttons' });
    const mk = (label: string, onclick: () => void, title?: string) => {
      const button = el('button', { type: 'button', title: title ?? label });
      button.textContent = label;
      button.addEventListener('click', () => {
        try {
          onclick();
        } catch (error) {
          this.log('error', (error as Error).message);
        }
      });
      return button;
    };
    wrap.append(
      mk('Observe', () => this.callbacks.observe(), 'Inspect the workspace and push state to the bridge'),
      mk('Ask Agent', () => this.callbacks.ask(this.refs.prompt.node.value), 'Send the prompt to the agent'),
      mk('Stop', () => this.callbacks.stop(), 'Cancel the running task'),
      mk('Checkpoint', () => this.callbacks.checkpoint(), 'Record a restorable checkpoint'),
      mk('Rollback', () => this.callbacks.rollback(), 'Roll back to the most recent checkpoint'),
      mk('Settings', () => this.toggleAdvanced(), 'Bridge connection settings'),
    );
    return wrap;
  }

  private advancedSection(): HTMLElement {
    const section = this.refs.advanced.node;
    const urlRow = el('div', { class: 'ai_row' });
    urlRow.append(labelNode('Bridge'), this.refs.url.node);
    const tokenRow = el('div', { class: 'ai_row' });
    tokenRow.append(labelNode('Token'), this.refs.token.node);
    const realtimeRow = el('div', { class: 'ai_row' });
    realtimeRow.append(this.refs.realtime.node, labelNode('Realtime state', 'ai_label'));
    const actions = el('div', { class: 'ai_buttons' });
    const connect = el('button', { type: 'button' });
    connect.textContent = 'Connect';
    connect.addEventListener('click', () => this.callbacks.reconnect(this.refs.url.node.value.trim(), this.refs.token.node.value.trim()));
    const disconnect = el('button', { type: 'button' });
    disconnect.textContent = 'Disconnect';
    disconnect.addEventListener('click', () => this.callbacks.disconnect());
    const logs = el('button', { type: 'button' });
    logs.textContent = 'Console log';
    logs.addEventListener('click', () => this.callbacks.openLogs());
    actions.append(connect, disconnect, logs);
    this.refs.realtime.node.addEventListener('change', () => this.callbacks.setRealtime(this.refs.realtime.node.checked));
    section.append(urlRow, tokenRow, realtimeRow, actions);
    return section;
  }

  private toggleAdvanced(): void {
    this.refs.advanced.node.classList.toggle('open');
  }

  setConnection(url: string, token: string, realtime: boolean): void {
    this.refs.url.node.value = url;
    this.refs.token.node.value = token;
    this.refs.realtime.node.checked = realtime;
  }

  setStatus(status: LinkStatus, detail: string): void {
    this.status = status;
    this.statusDetail = detail;
    const node = this.refs.status.node;
    node.classList.remove('connected', 'connecting');
    if (status === 'connected') node.classList.add('connected');
    else if (status === 'connecting') node.classList.add('connecting');
    const label = status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting' : status === 'rejected' ? 'Rejected' : 'Disconnected';
    this.refs.connection.node.textContent = detail ? `${label} — ${detail}` : label;
    this.refs.connection.node.title = detail ?? label;
  }

  setProgress(step: number, total: number, label: string): void {
    const percent = total > 0 ? Math.round((step / total) * 100) : 0;
    this.refs.progressBar.node.style.width = `${percent}%`;
    if (label) this.log('info', `${label} (${step}/${total})`);
  }

  update(state: PluginStateSnapshot): void {
    const project = state.project;
    this.refs.project.node.textContent = project ? `${project.project_name ?? 'untitled'}${project.saved ? '' : ' *'}` : 'none';
    this.refs.format.node.textContent = project ? `${project.format_name} (${project.format_id})` : 'none';
    this.refs.animation.node.textContent = state.animation
      ? `${state.animation.name} · ${state.animation.time}s / ${state.animation.length}s`
      : 'none';
    const selection = [
      state.selection.groups.length ? `${state.selection.groups.length} groups` : '',
      state.selection.elements.length ? `${state.selection.elements.length} elements` : '',
      state.selection.textures.length ? `${state.selection.textures.length} textures` : '',
    ]
      .filter(Boolean)
      .join(', ');
    this.refs.selection.node.textContent = selection || 'nothing';
    this.refs.counts.node.textContent = `${state.counts.elements} cubes · ${state.counts.groups} groups · ${state.counts.textures} textures · ${state.counts.animations} animations · ${state.counts.keyframes} keyframes`;
  }

  setBusy(busy: boolean): void {
    if (!busy) this.refs.progressBar.node.style.width = '0%';
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const prefix = level === 'error' ? '✖' : level === 'warn' ? '▲' : '•';
    const line = `${prefix} ${message}`;
    this.refs.log.node.textContent = `${line}\n${this.refs.log.node.textContent}`.slice(0, 4000);
  }

  getCurrentStatus(): { status: LinkStatus; detail: string } {
    return { status: this.status, detail: this.statusDetail };
  }

  delete(): void {
    try {
      this.panel.delete();
    } catch {
      /* ignore */
    }
    this.css?.delete();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  return node;
}

function row(...children: Array<HTMLElement | string>): HTMLElement {
  const container = el('div', { class: 'ai_row' });
  for (const child of children) {
    if (typeof child === 'string') container.append(labelNode(child));
    else container.append(child);
  }
  return container;
}

function labelNode(text: string, className = 'ai_label'): HTMLSpanElement {
  const node = el('span', { class: className });
  node.textContent = text;
  return node;
}
