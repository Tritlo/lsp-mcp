#!/usr/bin/env node
// Scripted LSP server for protocol regression tests.
// FAKE_LSP_HOVER:   hover text to return
// FAKE_LSP_MODE:    comma-separated behaviors:
//   content-type      send a Content-Type header before Content-Length
//   bytewise          write every outgoing byte in its own chunk
//   notify-after      send a publishDiagnostics notification right after each hover
//   no-hover          never answer hover requests
//   encoded-uris      publish diagnostics on didOpen with %-encoded URIs, as vscode-uri does

const modes = new Set((process.env.FAKE_LSP_MODE || '').split(',').filter(Boolean));
const hoverText = process.env.FAKE_LSP_HOVER || 'hover';

function write(bytes) {
  if (!modes.has('bytewise')) {
    process.stdout.write(bytes);
    return;
  }
  for (let i = 0; i < bytes.length; i++) process.stdout.write(bytes.subarray(i, i + 1));
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const contentType = modes.has('content-type') ? 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n' : '';
  write(Buffer.concat([Buffer.from(`${contentType}Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}

const encodeFileUri = (uri) => {
  const path = decodeURIComponent(new URL(uri).pathname);
  return 'file://' + path.split('/').map(encodeURIComponent).join('/');
};

function handle(message) {
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true } } });
      break;
    case 'textDocument/didOpen':
      if (modes.has('encoded-uris')) {
        send({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: {
            uri: encodeFileUri(message.params.textDocument.uri),
            diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'fake error', severity: 1 }]
          }
        });
      }
      break;
    case 'textDocument/hover':
      if (modes.has('no-hover')) break;
      send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'markdown', value: hoverText } } });
      if (modes.has('notify-after')) {
        send({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: {
            uri: message.params.textDocument.uri,
            diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'after hover', severity: 1 }]
          }
        });
      }
      break;
    case 'shutdown':
      send({ jsonrpc: '2.0', id: message.id, result: null });
      break;
    case 'exit':
      process.exit(0);
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (data) => {
  buffer = Buffer.concat([buffer, data]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const length = parseInt(buffer.subarray(0, headerEnd).toString('ascii').match(/Content-Length: (\d+)/i)[1], 10);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
