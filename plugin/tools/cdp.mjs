#!/usr/bin/env node
/**
 * Evaluate JavaScript inside the running Blockbench renderer.
 *
 *   node tools/cdp.mjs --eval "Project.selected ? Project.selected.name : 'none'"
 *   node tools/cdp.mjs --file script.js
 *   node tools/cdp.mjs --action ai_agent_observe      # click one of the plugin's actions
 *
 * This is only an *observation/interaction* channel for acceptance testing: everything
 * the agent does to the model goes through the bridge tool registry, not through here.
 *
 * Usage: cdp.mjs (-e <expr> | -f <file> | -a <actionId>) [--port 9333] [--wait ms]
 */
import http from 'node:http';
import fs from 'node:fs';
import WebSocket from 'ws';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
const port = Number(arg('--port', process.env.BLOCKBENCH_DEBUG_PORT ?? 9333));
const expr = arg('--eval', arg('-e'));
const file = arg('--file', arg('-f'));
const action = arg('--action', arg('-a'));

function listPages() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/json/list`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

const source = file ? fs.readFileSync(file, 'utf8') : expr;
if (!source) {
  console.error('nothing to evaluate: pass --eval "<expression>", --file <script> or --action <id>');
  process.exit(2);
}
const wrapped = action ? `(${JSON.stringify(action)}) => { const a = Blocks.ACTIONS?.[${JSON.stringify(action)}] ?? (typeof Action !== 'undefined' ? Action.all.find(x => x.id === ${JSON.stringify(action)}) : null); if (!a) return 'action not found'; a.click(); return 'clicked ' + a.id; }` : source;

try {
  const pages = (await listPages()).filter((page) => page.type === 'page');
  if (!pages.length) throw new Error(`no page on port ${port} — is Blockbench running with --remote-debugging-port=${port}?`);
  const socket = new WebSocket(pages[0].webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  let nextId = 0;
  const send = (method, params = {}) =>
    socket.send(JSON.stringify({ id: ++nextId, method, params }));
  const done = new Promise((resolve) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id === nextId) resolve(message);
    });
  });
  socket.on('open', () => send('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true, timeout: 30000 }));
  const reply = await done;
  if (reply.result?.exceptionDetails) {
    console.error('EXCEPTION:', reply.result.exceptionDetails.exception?.description ?? JSON.stringify(reply.result.exceptionDetails));
    process.exitCode = 1;
  } else {
    const value = reply.result?.result?.value;
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  socket.close();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = 1;
}
