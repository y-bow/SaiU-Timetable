const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

http.createServer((req, res) => {
  let fp = path.join(ROOT, req.url.split('?')[0]);
  if (fp.endsWith('/')) fp += 'index.html';
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fp);
    const types = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(8080, () => console.log('Running on 8080'));
