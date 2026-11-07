// Servidor de teste local: serve a pasta sem cache (para a medição de velocidade valer).
// Uso: node servidor.js   →  http://localhost:8088  (no celular, via `adb reverse tcp:8088 tcp:8088`)
// Também cria os arquivos de teste (bytes aleatórios: não comprimem) se faltarem.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const raiz = __dirname;
for (const tam of [65536, 262144, 1048576, 4194304]) {
  const f = path.join(raiz, `teste-${tam}.bin`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(tam));
}
if (!fs.existsSync(path.join(raiz, 'ping.txt'))) fs.writeFileSync(path.join(raiz, 'ping.txt'), 'ok');

const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.txt': 'text/plain', '.bin': 'application/octet-stream' };
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const arq = path.join(raiz, url === '/' ? 'index.html' : url);
  if (!arq.startsWith(raiz) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': tipos[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(arq).pipe(res);
}).listen(8088, () => console.log('Mapa de Conexão em http://localhost:8088'));
