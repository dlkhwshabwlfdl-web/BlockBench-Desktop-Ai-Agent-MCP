#!/usr/bin/env node
/**
 * Call one plugin tool with retries.
 *
 * Blockbench's plugin socket flaps roughly once a minute in this environment
 * (bridge close code 4000) and reconnects within a second or two, so a single
 * shot call has a real chance of landing in the gap. This waits for the link and
 * retries transient disconnects instead of failing the caller.
 *
 * Usage:
 *   node tools/call.mjs <tool> '<json args>'
 *   node tools/call.mjs <tool> --file args.json
 *   node tools/call.mjs health
 */
import fs from 'node:fs';

const BASE = process.env.AI_AGENT_BRIDGE ?? 'http://127.0.0.1:47311';
const [tool, ...rest] = process.argv.slice(2);
if (!tool) {
  console.error('usage: node tools/call.mjs <tool> [json|--file path] [--raw]');
  process.exitCode = 2;
  process.exit();
}

const raw = rest.includes('--raw');
const fileFlag = rest.indexOf('--file');
let args;
if (fileFlag >= 0) args = JSON.parse(fs.readFileSync(rest[fileFlag + 1], 'utf8'));
else {
  const inline = rest.find((a) => !a.startsWith('--'));
  args = inline ? JSON.parse(inline) : {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  try {
    const r = await fetch(`${BASE}/health`);
    return r.json();
  } catch {
    return null;
  }
}

async function waitForPlugin(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await health();
    if (h?.plugin_connected) return true;
    if (Date.now() > deadline) return false;
    await sleep(1500);
  }
}

if (tool === 'health') {
  console.log(JSON.stringify(await health(), null, 2));
  process.exit();
}

let lastError = null;
for (let attempt = 1; attempt <= 6; attempt += 1) {
  if (!(await waitForPlugin())) {
    lastError = new Error('plugin never connected');
    break;
  }
  let body;
  try {
    const response = await fetch(`${BASE}/tool/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    body = await response.json();
  } catch (error) {
    lastError = error;
    await sleep(1500);
    continue;
  }
  if (body.ok) {
    if (raw) {
      console.log(JSON.stringify(body, null, 2));
    } else {
      for (const w of body.warnings ?? []) console.error(`! ${w}`);
      console.log(JSON.stringify(body.data, null, 2));
    }
    process.exit();
  }
  const message = body.error?.message ?? JSON.stringify(body.error);
  const transient = /not connected|closed|socket|timeout|disconnect/i.test(message);
  lastError = new Error(`${tool}: ${message}`);
  if (!transient) {
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = 1;
    process.exit();
  }
  console.error(`  retry ${attempt}: ${message}`);
  await sleep(2000);
}

console.error(`FAILED ${tool} after retries: ${lastError?.message}`);
process.exitCode = 1;
