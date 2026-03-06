#!/usr/bin/env node
// Regression test: ensure server startup logs never leak to stdout.

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fsSync from 'fs';
import assert from 'assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LSP_MCP_SERVER = path.join(__dirname, '..', 'dist', 'index.js');
const TS_SERVER_BIN = path.join(__dirname, '..', 'node_modules', '.bin', 'typescript-language-server');

if (!fsSync.existsSync(LSP_MCP_SERVER)) {
  console.error(`ERROR: LSP MCP server not found at ${LSP_MCP_SERVER}`);
  console.error(`Make sure you've built the project with 'npm run build'`);
  process.exit(1);
}

try {
  const stats = fsSync.statSync(TS_SERVER_BIN);
  if (!stats.isFile()) {
    console.error(`Error: The typescript-language-server at '${TS_SERVER_BIN}' is not a file`);
    process.exit(1);
  }
} catch (error) {
  console.error(`Error: Could not find typescript-language-server at '${TS_SERVER_BIN}'`);
  console.error('Make sure you have installed the typescript-language-server as a dev dependency');
  process.exit(1);
}

const server = spawn('node', [LSP_MCP_SERVER, 'typescript', TS_SERVER_BIN, '--stdio'], {
  env: {
    ...process.env,
    LOG_LEVEL: 'info',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';

server.stdout.on('data', (data) => {
  stdout += data.toString();
});

server.stderr.on('data', (data) => {
  stderr += data.toString();
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForExit = () => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('close', resolve);
});

await wait(1000);
server.kill('SIGINT');
await waitForExit();

assert.strictEqual(
  stdout,
  '',
  `Server wrote unexpected data to stdout before client initialization:\n${stdout}`
);

console.log('✅ stdout safety test passed');
if (stderr.length > 0) {
  console.log(`Captured ${stderr.length} bytes on stderr as expected`);
}
