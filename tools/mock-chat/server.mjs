import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function startMock(port = 4173) {
  const assets = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['dist/app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
  };
  const server = createServer(async (request, response) => {
    const asset = assets[new URL(request.url, 'http://localhost').pathname];
    if (!asset) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const bytes = await readFile(new URL(asset[0], import.meta.url));
      response.writeHead(200, {
        'Content-Type': asset[1],
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; frame-ancestors 'none'",
      });
      response.end(bytes);
    } catch {
      response.writeHead(500);
      response.end('Run npm run mock:chat first.');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const server = await startMock(Number(process.env.PORT || 4173));
  console.log(
    `Mock React chat: ${server.url}（ローカルのみ・LLM 呼び出しなし）`,
  );
}
