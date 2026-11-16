// main.ts — the entrypoint: one process serving git smart HTTP, REST v3,
// GraphQL and MCP from the in-memory store. Lifecycle per RULES.txt: bind an
// ephemeral port, register it with the env server, poll /done until the run
// finishes, then exit 0. Without MAKEFUN_ENV_URL it runs standalone on $PORT
// (default 18080) for local development. Written from scratch in-session.

import http from 'node:http';
import https from 'node:https';
import { Store } from './store.ts';
import { createServer } from './app.ts';

const POLL_MS = 250;

function envUrl(path: string): string {
  const base = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');
  return `${base}${path}`;
}

function postJson(url: string, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(payload);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      parsed,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`register failed with status ${res.statusCode}`));
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createServer(store, { token: process.env.MAKEFUN_SHOP_TOKEN });
  const envUrlBase = process.env.MAKEFUN_ENV_URL;
  if (envUrlBase === undefined || envUrlBase === '') {
    const port = Number(process.env.PORT ?? '18080');
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    console.log(`makefun-forge listening on http://127.0.0.1:${port} (standalone)`);
    return;
  }
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('failed to bind'));
      else resolve(address.port);
    });
  });
  await postJson(envUrl('/register'), { port });
  for (;;) {
    const done = await getJson(envUrl('/done'));
    if (typeof done === 'object' && done !== null && (done as { done?: unknown }).done === true) break;
    await sleep(POLL_MS);
  }
  server.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
