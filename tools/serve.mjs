import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { inside, projectPath } from './bootstrap-game.mjs';
import { verifyBuild } from './check-game.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

export function resolveRequest(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) throw new Error('Invalid path');
  const segments = decoded.split('/');
  if (segments.some(segment => segment === '..' || segment === '.')) throw new Error('Traversal rejected');
  const file = path.resolve(root, '.' + decoded, decoded.endsWith('/') ? 'index.html' : '');
  if (!inside(root, file)) throw new Error('Outside build');
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!inside(fs.realpathSync(root), fs.realpathSync(ancestor))) throw new Error('Linked outside build');
  return file;
}

export function createStaticServer(root) {
  return http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    let file;
    try { file = resolveRequest(root, request.url || '/'); }
    catch { response.writeHead(403); response.end('Forbidden'); return; }
    let stat;
    try { stat = fs.statSync(file); } catch { response.writeHead(404); response.end('Not found'); return; }
    if (!stat.isFile()) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = fs.createReadStream(file);
    // An aborted response can leave a piped file paused before it reaches EOF.
    response.once('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--port')) throw new Error('Usage: node tools/serve.mjs [--port 7456]');
    const port = Number(args[1] || 7456);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
    const manifest = verifyBuild('web-desktop');
    const server = createStaticServer(projectPath('game/build/web-desktop'));
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Cocos ${manifest.revision} ready at http://127.0.0.1:${port}/ — Ctrl+C stops this process`));
    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
