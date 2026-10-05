// Fake streamable-HTTP MCP server for measuring CLI behaviour on outage shapes.
// MODE=refuse|hold|503|ok  PORT=n  HOLD_S=n  REOPEN_S=n
import http from 'node:http';
const MODE = process.env.MODE, PORT = Number(process.env.PORT), HOLD_S = Number(process.env.HOLD_S ?? 60), REOPEN_S = Number(process.env.REOPEN_S ?? 0);
const t0 = Date.now();
const log = (...a) => console.log(`[fake ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sockets = new Set();
let server;
function json(res, id, result) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
function handler(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    log(req.method, req.url, body.slice(0, 160));
    if (req.method !== 'POST') return void res.writeHead(405).end();
    const msg = JSON.parse(body);
    if (msg.id === undefined) return void res.writeHead(202).end();
    if (msg.method === 'initialize')
      return json(res, msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
    if (msg.method === 'tools/list') {
      json(res, msg.id, { tools: [{ name: 'ping', description: 'Record a ping. Returns pong.', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } }] });
      if (MODE === 'refuse') setTimeout(goDown, 200);
      return;
    }
    if (msg.method === 'tools/call') {
      if (MODE === 'rpcerr') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Buddy backend unavailable for 55 s; this call was not delivered.' } })); }
      if (MODE === '503') { log('-> 503'); return void res.writeHead(503, { 'retry-after': '5' }).end('backend restarting'); }
      if (MODE === 'hold') { log(`-> holding ${HOLD_S}s`); res.on('close', () => log('client closed held request', res.writableEnded ? '(after answer)' : '(BEFORE answer)')); return void setTimeout(() => { if (!res.destroyed) { log('-> answering held call'); json(res, msg.id, { content: [{ type: 'text', text: 'pong (held)' }] }); } }, HOLD_S * 1000); }
      return json(res, msg.id, { content: [{ type: 'text', text: 'pong' }] });
    }
    json(res, msg.id, {});
  });
}
function up() {
  server = http.createServer(handler);
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.listen(PORT, '127.0.0.1', () => log('listening', PORT));
}
function goDown() {
  log('GOING DOWN (refuse)');
  server.close();
  for (const s of sockets) s.destroy();
  if (REOPEN_S) setTimeout(up, REOPEN_S * 1000);
}
up();
process.on('SIGTERM', () => process.exit(0));
