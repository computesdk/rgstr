#!/usr/bin/env node
// Talks to the built server over stdio the way a client does: initialize,
// tools/list, then rgstr_whois for a name. Usage: node scripts/stdio-smoke.mjs [name]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(here, '..', 'dist', 'index.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
const name = process.argv[2] ?? 'computesdk';
let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});
let nextId = 1;
const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-smoke', version: '0' } });
console.log('# initialize →', JSON.stringify({ serverInfo: init.result.serverInfo, instructions: init.result.instructions.split('\n')[0] + ' …' }));
notify('notifications/initialized', {});
const list = await send('tools/list', {});
console.log('# tools/list →', list.result.tools.map((t) => t.name).join(', '));
const whois = await send('tools/call', { name: 'rgstr_whois', arguments: { name } });
console.log(`# tools/call rgstr_whois ${name} →`);
console.log(whois.result.content[0].text);
child.kill();
