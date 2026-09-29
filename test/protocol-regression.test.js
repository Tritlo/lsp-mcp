#!/usr/bin/env node
// Regression tests for LSP message framing, file URIs and process lifecycle,
// run against a scripted fake LSP server (test/fixtures/fake-lsp-server.js).

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import assert from 'assert';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'emergency';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { LSPClient } = await import(path.join(__dirname, '..', 'dist', 'src', 'lspClient.js'));
const { createFileUri } = await import(path.join(__dirname, '..', 'dist', 'src', 'tools', 'index.js'));

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-lsp-server.js');
const DOC_URI = createFileUri('/tmp/example.hs');
const POSITION = { line: 0, character: 0 };

// Requests time out after 10s, so anything slower than this means a lost message
const within = (ms, promise, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms}ms`)), ms))
]);

async function startClient({ mode = '', hover = 'hover', serverPath = process.execPath, args = [FAKE_SERVER] } = {}) {
  process.env.FAKE_LSP_MODE = mode;
  process.env.FAKE_LSP_HOVER = hover;
  const client = new LSPClient(serverPath, args);
  await within(3000, client.initialize(os.tmpdir()), 'initialize');
  await client.openDocument(DOC_URI, 'main = pure ()', 'haskell');
  return client;
}

const tests = {
  async 'non-ASCII hover response is read in full'() {
    const hover = 'f ∷ Int → Int -- ‘quoted’ 型';
    const client = await startClient({ hover });
    assert.strictEqual(await within(3000, client.getInfoOnLocation(DOC_URI, POSITION), 'hover'), hover);
    await client.shutdown();
  },

  async 'long non-ASCII response followed by a notification keeps the stream in sync'() {
    const hover = 'f ∷ ' + Array(300).fill('Int').join(' → ');
    const client = await startClient({ mode: 'notify-after', hover });
    assert.strictEqual(await within(3000, client.getInfoOnLocation(DOC_URI, POSITION), 'first hover'), hover);
    assert.strictEqual(await within(3000, client.getInfoOnLocation(DOC_URI, POSITION), 'second hover'), hover);
    assert.strictEqual(client.getDiagnostics(DOC_URI).length, 1);
    await client.shutdown();
  },

  async 'multi-byte characters split across chunks are decoded intact'() {
    const hover = '→ ∷ 型 😀';
    const client = await startClient({ mode: 'bytewise', hover });
    assert.strictEqual(await within(3000, client.getInfoOnLocation(DOC_URI, POSITION), 'hover'), hover);
    await client.shutdown();
  },

  async 'Content-Type header is accepted'() {
    const client = await startClient({ mode: 'content-type' });
    assert.strictEqual(await within(3000, client.getInfoOnLocation(DOC_URI, POSITION), 'hover'), 'hover');
    await client.shutdown();
  },

  async 'diagnostics are found for paths with spaces when the server %-encodes URIs'() {
    const client = await startClient({ mode: 'encoded-uris' });
    const uri = createFileUri(path.join(os.tmpdir(), 'my project', 'Main.hs'));
    await client.openDocument(uri, 'main = pure ()', 'haskell');
    await within(3000, (async () => {
      while (client.getDiagnostics(uri).length === 0) await new Promise(r => setTimeout(r, 20));
    })(), 'diagnostics');
    await client.shutdown();
  },

  async 'file URIs round-trip for paths with spaces and #'() {
    for (const p of ['/tmp/my project/Main.hs', '/tmp/c#/Main.hs', '/tmp/100%/Main.hs']) {
      assert.strictEqual(fileURLToPath(createFileUri(p)), p);
    }
  },

  async 'restart settles requests that were waiting on the old server'() {
    const client = await startClient({ mode: 'no-hover' });
    const pending = client.getInfoOnLocation(DOC_URI, POSITION);
    await new Promise(r => setTimeout(r, 100));
    await client.restart(os.tmpdir());
    assert.strictEqual(await within(3000, pending, 'pending hover after restart'), '');
    await client.shutdown();
  },

  async 'a server binary that cannot be spawned fails initialize instead of crashing'() {
    const notExecutable = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-mcp-')), 'server');
    fs.writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });
    const client = new LSPClient(notExecutable, []);
    await assert.rejects(within(3000, client.initialize(os.tmpdir()), 'initialize'), /EACCES|ENOENT|spawn/);
  },
};

// The server's logging module takes over console.*, so report on stderr directly
const report = (line) => process.stderr.write(line + '\n');

let failed = 0;
for (const [name, test] of Object.entries(tests)) {
  try {
    await test();
    report(`✅ ${name}`);
  } catch (error) {
    failed++;
    report(`❌ ${name}: ${error instanceof Error ? error.message : error}`);
  }
}
report(failed === 0 ? '✅ All protocol regression tests passed' : `❌ ${failed} protocol regression test(s) failed`);
process.exit(failed === 0 ? 0 : 1);
