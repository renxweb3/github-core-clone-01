// app.ts — the HTTP server: routing, auth, body reading, JSON 404s, and the
// git smart-HTTP endpoints. Written from scratch in-session.
// Auth: MAKEFUN_SHOP_TOKEN when set must match exactly; when unset (local
// dev only) any non-empty Bearer is accepted and a missing token is a 401.
// /healthz takes no auth; git endpoints take no auth; GET /api/v3/ and
// /api/v3/meta are public; everything else under /api/v3, /api/graphql and
// /mcp requires the token.

import http from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertisementV0,
  advertisementV2,
  decodePktLinesPrefix,
  packetLines,
  parseLsRefsRequest,
  lsRefsResponse,
  parseFetchV2Request,
  fetchV2Response,
  parseFetchV0Request,
  fetchV0Response,
  handleReceivePack,
} from './git.ts';
import type { ReqCtx, Resp } from './types.ts';
import { notFound, errorResp, unauthorized } from './types.ts';

export interface AppOptions {
  /** The entry token; undefined means local-dev mode (any non-empty Bearer). */
  readonly token?: string;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function handleGitRoute(ctx: ReqCtx, owner: string, repoName: string, action: string): Resp {
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) return notFound('Not Found');
  if (action === 'info/refs') {
    if (ctx.method !== 'GET') return errorResp(405, 'Method Not Allowed');
    const service = ctx.query.get('service');
    if (service === 'git-upload-pack') {
      const v2 = ctx.headers['git-protocol'] === 'version=2';
      return {
        status: 200,
        body: v2 ? advertisementV2() : advertisementV0(repo, 'git-upload-pack'),
        contentType: 'application/x-git-upload-pack-advertisement',
      };
    }
    if (service === 'git-receive-pack') {
      return {
        status: 200,
        body: advertisementV0(repo, 'git-receive-pack'),
        contentType: 'application/x-git-receive-pack-advertisement',
      };
    }
    return errorResp(400, 'service is required');
  }
  if (action === 'git-upload-pack') {
    if (ctx.method !== 'POST') return errorResp(405, 'Method Not Allowed');
    try {
      const v2 = ctx.headers['git-protocol'] === 'version=2';
      if (v2) {
        const { packets } = decodePktLinesPrefix(ctx.body);
        const first = (packetLines(packets)[0] ?? '').trim();
        if (first === 'command=ls-refs') {
          return { status: 200, body: lsRefsResponse(repo, parseLsRefsRequest(ctx.body)), contentType: 'application/x-git-upload-pack-result' };
        }
        if (first === 'command=fetch') {
          return { status: 200, body: fetchV2Response(repo, parseFetchV2Request(ctx.body)), contentType: 'application/x-git-upload-pack-result' };
        }
        return errorResp(400, 'unknown command');
      }
      return { status: 200, body: fetchV0Response(repo, parseFetchV0Request(ctx.body)), contentType: 'application/x-git-upload-pack-result' };
    } catch {
      return errorResp(400, 'malformed request');
    }
  }
  if (action === 'git-receive-pack') {
    if (ctx.method !== 'POST') return errorResp(405, 'Method Not Allowed');
    try {
      return { status: 200, body: handleReceivePack(repo, ctx.body), contentType: 'application/x-git-receive-pack-result' };
    } catch {
      return errorResp(400, 'malformed request');
    }
  }
  return notFound();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function handleGraphQL(ctx: ReqCtx): Resp {
  if (ctx.jsonError) return errorResp(400, 'Invalid JSON body');
  const body = ctx.json;
  const runOne = (item: unknown): unknown => {
    if (!isRecord(item) || typeof item.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const variables = isRecord(item.variables) ? item.variables : {};
    const operationName = typeof item.operationName === 'string' ? item.operationName : undefined;
    return executeGraphQL(ctx.store, item.query, variables, operationName);
  };
  if (Array.isArray(body)) return { status: 200, body: body.map(runOne) };
  return { status: 200, body: runOne(body) };
}

function writeResp(res: http.ServerResponse, ctx: ReqCtx, resp: Resp): void {
  res.setHeader('x-github-request-id', ctx.requestId);
  if (resp.headers !== undefined) {
    for (const [name, value] of Object.entries(resp.headers)) res.setHeader(name, value);
  }
  if (resp.status === 204 || resp.body === undefined) {
    res.writeHead(resp.status);
    res.end();
    return;
  }
  if (Buffer.isBuffer(resp.body)) {
    res.setHeader('content-type', resp.contentType ?? 'application/octet-stream');
    res.writeHead(resp.status);
    res.end(resp.body);
    return;
  }
  if (typeof resp.body === 'string') {
    res.setHeader('content-type', resp.contentType ?? 'text/plain');
    res.writeHead(resp.status);
    res.end(resp.body);
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.writeHead(resp.status);
  res.end(JSON.stringify(resp.body));
}

async function handleRequest(store: Store, options: AppOptions, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path; the router will 404 it.
  }
  const body = await readBody(req);
  const isJsonRoute = pathname.startsWith('/api/v3') || pathname === '/api/graphql' || pathname === '/mcp';
  let json: unknown;
  let jsonError = false;
  if (isJsonRoute && body.length > 0) {
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      jsonError = true;
    }
  }
  const authHeader = req.headers.authorization;
  const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  const authed = options.token !== undefined ? bearer === options.token : bearer !== undefined && bearer !== '';
  const ctx: ReqCtx = {
    store,
    method: req.method ?? 'GET',
    pathname,
    query: url.searchParams,
    headers: req.headers,
    origin: `http://${req.headers.host ?? '127.0.0.1'}`,
    body,
    json,
    jsonError,
    authed,
    requestId: store.nextRequestId(),
  };

  let resp: Resp;
  if (pathname === '/healthz') {
    resp = ctx.method === 'GET' ? { status: 200, body: { ok: true } } : errorResp(405, 'Method Not Allowed');
  } else {
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
    if (gitMatch !== null) {
      resp = handleGitRoute(ctx, gitMatch[1] as string, gitMatch[2] as string, gitMatch[3] as string);
    } else if (pathname === '/api/v3/' || pathname === '/api/v3' || pathname === '/api/v3/meta') {
      resp = handleRest(ctx) ?? notFound();
    } else if (pathname.startsWith('/api/v3/')) {
      resp = !ctx.authed ? unauthorized() : (handleRest(ctx) ?? notFound());
    } else if (pathname === '/api/graphql') {
      resp = !ctx.authed ? unauthorized() : handleGraphQL(ctx);
    } else if (pathname === '/mcp') {
      resp = !ctx.authed ? unauthorized() : handleMcp(ctx);
    } else {
      resp = notFound();
    }
  }
  writeResp(res, ctx, resp);
}

export function createServer(store: Store, options: AppOptions = {}): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(store, options, req, res).catch((error: unknown) => {
      console.error('request failed:', error instanceof Error ? error.stack ?? error.message : error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      } catch {
        // The socket is gone; nothing to do.
      }
    });
  });
  return server;
}
