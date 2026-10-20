import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { createServer } from './server.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

// Options come from the CLI's environment: RGSTR_URL, RGSTR_TOKEN, RGSTR_ORG,
// RGSTR_HOME (the stored `rgstr login`), RGSTR_CWD for the default project.
const server = createServer({ cwd: process.env.RGSTR_CWD }, version);
server.connect(new StdioServerTransport()).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
