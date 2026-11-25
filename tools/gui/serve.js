#!/usr/bin/env node
'use strict';
// the real scratch editor on localhost, with out/linux.sb3 loaded into it.
//   (cd tools/gui && npm install)      once: fetches @scratch/scratch-gui, about 250 MB
//   node tools/gui/serve.js [--port 8601] [--sb3 out/linux.sb3]
//   then open http://127.0.0.1:8601/   (?go presses the green flag too, ?player shows only the stage)
const http = require('http');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const PORT = +opt('--port', 8601);
const SB3 = path.resolve(opt('--sb3', path.join(__dirname, '..', '..', 'out', 'linux.sb3')));
const DIST = path.join(__dirname, 'node_modules', '@scratch', 'scratch-gui', 'dist');
if (!fs.existsSync(path.join(DIST, 'scratch-gui-standalone.js'))) {
  console.error('the scratch editor is not installed yet. run:  (cd tools/gui && npm install)');
  process.exit(1);
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.sb3': 'application/octet-stream' };
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url === '/' || url === '/index.html') file = path.join(__dirname, 'index.html');
  else if (url === '/project.sb3') file = SB3;
  else {
    file = path.join(DIST, path.normalize(url));
    if (!file.startsWith(DIST + path.sep)) { res.writeHead(403).end(); return; }
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`scratch editor with ${path.relative(process.cwd(), SB3)}: http://127.0.0.1:${PORT}/?go`));
