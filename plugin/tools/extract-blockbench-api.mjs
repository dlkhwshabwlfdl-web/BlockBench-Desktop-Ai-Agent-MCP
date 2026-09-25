#!/usr/bin/env node
/**
 * Blockbench API extractor.
 *
 * The shipped Blockbench desktop build contains `resources/app.asar`, and its
 * `dist/bundle.js.map` embeds the *original* sources of the exact installed version
 * in `sourcesContent`. This script turns that into ground truth so the agent never
 * has to guess an API:
 *
 *   1. locates the installed Blockbench and reads its version
 *   2. extracts every Blockbench source file into `.blockbench-api/src/**`
 *   3. derives an API inventory (classes, methods, events, plugin globals, properties)
 *   4. writes `docs/BLOCKBENCH-API-REPORT.md` and `src/blockbench-api/generated/version.ts`
 *
 * Usage: node tools/extract-blockbench-api.mjs [--asar <path>] [--quiet]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, '.blockbench-api');
const SRC_DIR = path.join(OUT_DIR, 'src');
const DOC_DIR = path.join(ROOT, 'docs');
const GENERATED_DIR = path.join(ROOT, 'src', 'blockbench-api', 'generated');

const quiet = process.argv.includes('--quiet');

/* ------------------------------------------------------------------ locating */

function candidateAsarPaths() {
  const list = [];
  if (process.env.BLOCKBENCH_DIR) {
    list.push(path.join(process.env.BLOCKBENCH_DIR, 'resources', 'app.asar'));
    list.push(process.env.BLOCKBENCH_DIR);
  }
  const home = os.homedir();
  const platform = process.platform;
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    for (const dir of ['Blockbench', 'Programs/Blockbench', 'blockbench']) {
      list.push(path.join(local, dir, 'resources', 'app.asar'));
    }
    list.push('C:/Program Files/Blockbench/resources/app.asar');
  } else if (platform === 'darwin') {
    list.push('/Applications/Blockbench.app/Contents/Resources/app.asar');
  } else {
    list.push('/usr/lib/blockbench/resources/app.asar');
    list.push('/opt/Blockbench/resources/app.asar');
    list.push(path.join(home, '.local/share/Blockbench/resources/app.asar'));
  }
  // allow explicit override
  const idx = process.argv.indexOf('--asar');
  if (idx !== -1 && process.argv[idx + 1]) list.unshift(process.argv[idx + 1]);
  return list.filter(Boolean);
}

function locateAsar() {
  for (const candidate of candidateAsarPaths()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return path.resolve(candidate);
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/* --------------------------------------------------------------- asar reader */

function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const header = Buffer.alloc(16);
  fs.readSync(fd, header, 0, 16, 0);
  const headerString = header.toString('utf8', 0, 4);
  if (headerString !== 'Cr24') {
    // asar uses a pickle header: uint32 size at offset 12 is reliable enough here
  }
  const headerSize = header.readUInt32LE(12);
  const rawHeader = Buffer.alloc(headerSize);
  fs.readSync(fd, rawHeader, 0, headerSize, 16);
  const index = JSON.parse(rawHeader.toString('utf8'));
  // asar pads the data section to a 4 byte boundary; without this the first bytes
  // of every file are shifted and JSON payloads fail to parse.
  const unpadded = 16 + headerSize;
  const baseOffset = unpadded + ((4 - (unpadded % 4)) % 4);

  function stat(nodePath) {
    const parts = nodePath.split('/').filter(Boolean);
    let node = { files: index.files };
    for (const part of parts) {
      if (!node || !node.files || !node.files[part]) return null;
      node = node.files[part];
    }
    return node;
  }

  function read(nodePath) {
    const node = stat(nodePath);
    if (!node || node.files) return null;
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset || 0));
    return buf.toString('utf8');
  }

  return { index, stat, read, close: () => fs.closeSync(fd) };
}

/* ------------------------------------------------------------- source mapping */

function readBundleSourceMap(asar) {
  const raw = asar.read('dist/bundle.js.map');
  if (!raw) throw new Error('dist/bundle.js.map not found inside app.asar');
  return JSON.parse(raw);
}

function isBlockbenchSource(name) {
  return name.startsWith('../js/') || name.startsWith('js/');
}

function normalizeSourceName(name) {
  return name.replace(/^\.\.\//, '');
}

/* ------------------------------------------------------------------ inventory */

const SKIP_NAMES = new Set(['Object', 'Merge', 'Math', 'JSON', 'PathModule']);

function extractClasses(code) {
  const classes = [];
  const lines = code.split(/\r?\n/);
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const classMatch = /^(\s*)(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+([A-Za-z_$][\w$.]*))?/.exec(line);
    if (classMatch && classMatch[1].length <= 1) {
      current = { name: classMatch[2], extends: classMatch[3] || null, methods: [], statics: [], properties: [] };
      classes.push(current);
      continue;
    }
    if (!current) continue;
    if (/^export\s+/.test(line) || /^(const|let|var|function|interface|type)\s/.test(line)) {
      current = null;
      continue;
    }
    const method = /^\s{1,2}(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/.exec(line);
    if (method) {
      const isStatic = /\bstatic\b/.test(line);
      const entry = { name: method[1], args: method[2].trim() };
      if (method[1] === 'constructor') continue;
      (isStatic ? current.statics : current.methods).push(entry);
      continue;
    }
    const prop = /^\s{1,2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[:?]\s*([^;=]+)[;=]?\s*$/.exec(line);
    if (prop && !prop[1].startsWith('#')) {
      current.properties.push({ name: prop[1], type: prop[2].trim() });
    }
  }
  return classes.filter((c) => c.methods.length || c.statics.length || c.properties.length);
}

function extractDispatchedEvents(sources) {
  const events = new Map();
  const re = /dispatchEvent\(\s*['"]([a-z_0-9]+)['"]/g;
  for (const [file, code] of sources) {
    let m;
    while ((m = re.exec(code))) {
      if (!events.has(m[1])) events.set(m[1], file);
    }
  }
  return [...events.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Reads the top level keys of an object literal assigned to `name`.
 *
 * Blockbench modules almost never inline the object into `Object.assign(window, {...})`;
 * they build `const global = {...}` and then assign that variable. Brace matching is
 * required because these literals contain nested objects, functions and arrays.
 */
function extractObjectLiteralKeys(code, name) {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`);
  const match = re.exec(code);
  if (!match) return [];
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let end = start;
  for (; end < code.length; end++) {
    const ch = code[end];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  const body = code.slice(start + 1, end - 1);
  const keys = [];
  let nested = 0;
  let token = '';
  const flush = () => {
    const cleaned = token.trim().replace(/,$/, '').trim();
    token = '';
    if (!cleaned) return;
    const key = cleaned.split(':')[0].trim().replace(/^\.\.\./, '');
    if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key);
  };
  for (const ch of body) {
    if ('{[('.includes(ch)) nested++;
    else if ('}])'.includes(ch)) nested--;
    if (ch === ',' && nested === 0) {
      flush();
      continue;
    }
    token += ch;
  }
  flush();
  return keys;
}

function extractWindowGlobals(sources) {
  const globals = new Set();
  for (const [, code] of sources) {
    // Object.assign(window, { a, b, c })
    const inline = /Object\.assign\(window,\s*\{([^}]*)\}/g;
    let m;
    while ((m = inline.exec(code))) {
      for (const raw of m[1].split(',')) {
        const name = raw.split(':')[0].trim().replace(/\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(name)) globals.add(name);
      }
    }
    // const global = {...}; Object.assign(window, global)
    const viaVariable = /Object\.assign\(window,\s*([A-Za-z_$][\w$]*)\s*\)/g;
    while ((m = viaVariable.exec(code))) {
      for (const key of extractObjectLiteralKeys(code, m[1])) globals.add(key);
    }
    // Object.assign(window, { ...global, extra }) is not used by Blockbench; skipped.
    const single = /window\.([A-Za-z_$][\w$]*)\s*=\s*[^=]/g;
    while ((m = single.exec(code))) globals.add(m[1]);
  }
  return [...globals].sort();
}

function extractProperties(sources) {
  const props = new Map();
  const re = /new Property\(\s*([A-Za-z_$][\w$.]*)\s*,\s*'([a-z]+)'\s*,\s*'([\w$]+)'/g;
  for (const [file, code] of sources) {
    let m;
    while ((m = re.exec(code))) {
      const key = m[1];
      if (!props.has(key)) props.set(key, { file, entries: [] });
      props.get(key).entries.push({ type: m[2], name: m[3] });
    }
  }
  return props;
}

function extractCodecs(sources) {
  const found = [];
  const re = /new Codec\(\s*'([\w-]+)'\s*,\s*\{/g;
  for (const [file, code] of sources) {
    let m;
    while ((m = re.exec(code))) found.push({ id: m[1], file });
  }
  return found;
}

function extractFormats(sources) {
  const found = [];
  const re = /new ModelFormat\(\s*'([\w-]+)'\s*,\s*\{/g;
  for (const [file, code] of sources) {
    let m;
    while ((m = re.exec(code))) found.push({ id: m[1], file });
  }
  return found;
}

/* ------------------------------------------------------------------ reporting */

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function buildReport({ version, asarPath, sources, classes, events, globals, properties, codecs, formats }) {
  const out = [];
  out.push(`# Blockbench API report`);
  out.push('');
  out.push(`> Auto-generated by \`tools/extract-blockbench-api.mjs\`. Do not edit by hand.`);
  out.push('');
  out.push(`- **Installed Blockbench version:** \`${version}\``);
  out.push(`- **Source of truth:** \`${asarPath}\` → \`dist/bundle.js.map\``);
  out.push(`- **Extracted Blockbench source files:** ${sources.size}`);
  out.push(`- **Generated:** ${new Date().toISOString()}`);
  out.push('');
  out.push(`Every method listed here was read out of the installed build. If a method is not`);
  out.push(`listed, it does not exist in this version and must not be used.`);
  out.push('');

  out.push(`## Plugin globals available at runtime`);
  out.push('');
  out.push('These identifiers are assigned to `window` by the Blockbench bundle and can be');
  out.push('referenced directly from plugin code (which runs through `new Function`).');
  out.push('');
  out.push(
    globals
      .map((g) => `\`${g}\``)
      .join(', ')
  );
  out.push('');

  out.push(`## Registered property groups`);
  out.push('');
  out.push("Properties are declared with `new Property(Class, type, 'name', options)`. They are");
  out.push('the supported way to read/write node data and are automatically merged by `extend()`.');
  out.push('');
  const propRows = [];
  for (const [key, info] of [...properties.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    propRows.push([`\`${key}\``, info.entries.map((e) => `\`${e.name}: ${e.type}\``).join('<br>'), `\`${info.file}\``]);
  }
  out.push(mdTable(['Class', 'Properties', 'Defined in'], propRows));
  out.push('');

  out.push(`## Codecs`);
  out.push('');
  out.push(mdTable(['Codec id', 'Defined in'], codecs.map((c) => [`\`${c.id}\``, `\`${c.file}\``])));
  out.push('');

  out.push(`## Model formats`);
  out.push('');
  out.push(mdTable(['Format id', 'Defined in'], formats.map((c) => [`\`${c.id}\``, `\`${c.file}\``])));
  out.push('');

  out.push(`## Dispatched events (${events.length})`);
  out.push('');
  out.push('Pass these names to `Blockbench.on(name, cb)` / `Blockbench.dispatchEvent(name, data)`.');
  out.push('');
  out.push(mdTable(['Event', 'First dispatched in'], events.map(([name, file]) => [`\`${name}\``, `\`${file}\``])));
  out.push('');

  out.push(`## Class inventory`);
  out.push('');
  out.push('Public methods (and static methods) for every class with any discovered member.');
  out.push('');
  for (const cls of classes) {
    if (SKIP_NAMES.has(cls.name)) continue;
    const methodList = cls.methods.map((m) => `\`${m.name}(${m.args})\``).join(', ');
    const staticList = cls.statics.map((m) => `\`${cls.name}.${m.name}(${m.args})\``).join(', ');
    const propList = cls.properties.map((p) => `\`${p.name}\``).join(', ');
    const bits = [];
    if (staticList) bits.push(`**static:** ${staticList}`);
    if (methodList) bits.push(`**instance:** ${methodList}`);
    if (propList) bits.push(`**fields:** ${propList}`);
    out.push(`### \`${cls.name}\`${cls.extends ? ` (extends \`${cls.extends}\`)` : ''}`);
    out.push('');
    out.push(bits.join('\n\n') || '_no members discovered_');
    out.push('');
  }

  return out.join('\n');
}

/* ----------------------------------------------------------------------- main */

function main() {
  const asarPath = locateAsar();
  if (!asarPath) {
    console.error('Could not find a Blockbench installation. Set BLOCKBENCH_DIR or pass --asar <path>.');
    process.exitCode = 1;
    return;
  }
  const asar = openAsar(asarPath);
  const pkgRaw = asar.read('package.json');
  const pkg = JSON.parse(pkgRaw);
  const version = pkg.version;
  if (!quiet) console.log(`Blockbench ${version} found at ${asarPath}`);

  const map = readBundleSourceMap(asar);
  const sources = new Map();
  map.sources.forEach((name, i) => {
    if (!isBlockbenchSource(name)) return;
    const content = map.sourcesContent?.[i];
    if (typeof content !== 'string') return;
    sources.set(normalizeSourceName(name), content);
  });

  // 1. write extracted sources
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  for (const [name, content] of sources) {
    const target = path.join(SRC_DIR, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'sourcemap-sources.json'),
    JSON.stringify({ version, asarPath, files: [...sources.keys()] }, null, 2),
    'utf8'
  );

  // 2. derive inventory
  const classes = [];
  for (const [name, content] of sources) {
    for (const cls of extractClasses(content)) {
      classes.push({ ...cls, file: name });
    }
  }
  const events = extractDispatchedEvents(sources);
  const globals = extractWindowGlobals(sources);
  const properties = extractProperties(sources);
  const codecs = extractCodecs(sources);
  const formats = extractFormats(sources);

  // 3. write report + generated version module
  fs.mkdirSync(DOC_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DOC_DIR, 'BLOCKBENCH-API-REPORT.md'),
    buildReport({ version, asarPath, sources, classes, events, globals, properties, codecs, formats }),
    'utf8'
  );

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(GENERATED_DIR, 'version.ts'),
    `// Auto-generated by tools/extract-blockbench-api.mjs — do not edit.\n` +
      `export const DETECTED_BLOCKBENCH_VERSION = ${JSON.stringify(version)};\n` +
      `export const DETECTED_BLOCKBENCH_ASAR = ${JSON.stringify(asarPath)};\n` +
      `export const DETECTED_SOURCE_COUNT = ${sources.size};\n` +
      `export const DETECTED_EVENT_COUNT = ${events.length};\n`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(GENERATED_DIR, 'events.ts'),
    `// Auto-generated by tools/extract-blockbench-api.mjs — do not edit.\n` +
      `// Every name below was found in a Blockbench.dispatchEvent(...) call inside the\n` +
      `// installed build (${version}). Names absent from this list do not exist.\n` +
      `export const DETECTED_BLOCKBENCH_VERSION = ${JSON.stringify(version)};\n` +
      `export const BLOCKBENCH_EVENTS: readonly string[] = [\n` +
      events.map(([name, file]) => `  ${JSON.stringify(name)}, // ${file}`).join('\n') +
      `\n];\n`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(GENERATED_DIR, 'globals.ts'),
    `// Auto-generated by tools/extract-blockbench-api.mjs — do not edit.\n` +
      `// Identifiers the Blockbench bundle assigns to window and plugin code may use.\n` +
      `export const DETECTED_BLOCKBENCH_VERSION = ${JSON.stringify(version)};\n` +
      `export const BLOCKBENCH_GLOBALS: readonly string[] = [\n` +
      globals.map((name) => `  ${JSON.stringify(name)},`).join('\n') +
      `\n];\n`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(OUT_DIR, 'inventory.json'),
    JSON.stringify({ version, asarPath, events, globals, codecs, formats }, null, 2),
    'utf8'
  );

  asar.close();

  if (!quiet) {
    console.log(`Extracted ${sources.size} Blockbench source files -> ${OUT_DIR}`);
    console.log(`Inventory: ${classes.length} classes, ${events.length} events, ${globals.length} globals`);
    console.log(`Report -> docs/BLOCKBENCH-API-REPORT.md`);
  }
}

main();
