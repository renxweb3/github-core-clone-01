// mcp.ts — the MCP endpoint (POST /mcp), JSON-RPC 2.0 over Streamable HTTP.
// Plain JSON responses only (the suite accepts them; SSE is not implemented).
// Implements the modern era (server/discover) and the legacy initialize
// fallback, tools/list (byte-identical across calls), and tools/call for the
// six canonical github-mcp-server tools. Written from scratch in-session.

import { VIEWER_LOGIN, VIEWER_ID, type Repo, type Issue, type Pull } from './store.ts';
import type { ReqCtx, Resp } from './types.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];
const KNOWN_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The six tools, frozen so tools/list is byte-identical on every call. */
const TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the issue.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state: open, closed, or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the pull request.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the pull request.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

interface RpcResult {
  readonly content: { type: string; text: string }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function okResult(obj: unknown): RpcResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function errorResult(message: string): RpcResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    full_name: `${repo.owner}/${repo.name}`,
    head: { ref: pull.head, sha: '' },
    base: { ref: pull.base, sha: '' },
  };
}

function callTool(ctx: ReqCtx, name: string, args: Record<string, unknown>): { result: RpcResult } | { error: { code: number; message: string } } {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { error: { code: -32602, message: `unknown tool: ${name}` } };
  const required = (tool.inputSchema as { required: string[] }).required;
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return { result: errorResult(`missing required argument: ${key}`) };
    }
  }

  if (name === 'create_repo') {
    const repoName = str(args.name) as string;
    const created = ctx.store.createRepo(VIEWER_LOGIN, repoName, str(args.description) ?? '', args.private === true);
    if (created === null) return { result: errorResult('Repository already exists') };
    return { result: okResult(repoJson(created)) };
  }

  // Every remaining tool needs an existing repo.
  const owner = str(args.owner) as string;
  const repoName = str(args.repo) as string;
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) return { result: errorResult('Repository not found') };

  if (name === 'get_repo') {
    return { result: okResult(repoJson(repo)) };
  }
  if (name === 'create_issue') {
    const created = ctx.store.createIssue(repo, str(args.title) as string, str(args.body) ?? '', []);
    if ('error' in created) return { result: errorResult(created.error) };
    return { result: okResult(issueJson(repo, created.issue)) };
  }
  if (name === 'list_issues') {
    const state = str(args.state) ?? 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => b.seq - a.seq);
    return { result: okResult({ issues: list.map((issue) => issueJson(repo, issue)) }) };
  }
  if (name === 'create_pull_request') {
    const created = ctx.store.createPull(repo, str(args.head) as string, str(args.base) as string, str(args.title) as string, str(args.body) ?? '');
    if ('error' in created) return { result: errorResult(created.error) };
    return { result: okResult(pullJson(repo, created.pull)) };
  }
  if (name === 'merge_pull_request') {
    const pullNumber = args.pull_number as number;
    const pull = ctx.store.getPull(repo, pullNumber);
    if (pull === undefined) return { result: errorResult('Pull request not found') };
    const merged = ctx.store.mergePull(repo, pull);
    if ('error' in merged) return { result: errorResult(merged.error) };
    return { result: okResult({ merged: true, sha: merged.sha, message: 'Pull request successfully merged.' }) };
  }
  return { error: { code: -32602, message: `unknown tool: ${name}` } };
}

export function handleMcp(ctx: ReqCtx): Resp {
  // A body that is not JSON at all is a JSON-RPC parse error (id null).
  if (ctx.jsonError) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const body = ctx.json;
  if (!isRecord(body) || typeof body.method !== 'string') {
    return {
      status: 200,
      body: { jsonrpc: '2.0', id: isRecord(body) ? (body.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const id = body.id ?? null;
  // Notifications (no id) get a bare 202.
  if (body.id === undefined) {
    return { status: 202 };
  }
  const params = isRecord(body.params) ? body.params : {};

  if (body.method === 'server/discover') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        },
      },
    };
  }
  if (body.method === 'initialize') {
    const offered = str(params.protocolVersion);
    if (offered === undefined || !KNOWN_VERSIONS.includes(offered)) {
      return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unsupported protocol version' } } };
    }
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: offered,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      },
    };
  }
  if (body.method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (body.method === 'tools/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
  }
  if (body.method === 'tools/call') {
    const toolName = str(params.name);
    if (toolName === undefined) {
      return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'missing tool name' } } };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const outcome = callTool(ctx, toolName, args);
    if ('error' in outcome) {
      return { status: 200, body: { jsonrpc: '2.0', id, error: outcome.error } };
    }
    return { status: 200, body: { jsonrpc: '2.0', id, result: outcome.result } };
  }
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${body.method}` } } };
}
