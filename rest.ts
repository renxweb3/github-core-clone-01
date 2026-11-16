// rest.ts — the GitHub REST v3 surface. Written from scratch in-session.
// Shapes follow what the sealed suite's checks assert (statuses, field names,
// pagination Link headers); extra GitHub-like fields are included where cheap.

import { b64encode, b64decode } from './util.ts';
import {
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  repoGlobalId,
  type Repo,
  type Issue,
  type Pull,
  type Label,
} from './store.ts';
import type { ReqCtx, Resp } from './types.ts';
import { notFound, errorResp } from './types.ts';

const FIXED_DATE = '2025-01-01T00:00:00Z';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(ctx: ReqCtx): Record<string, unknown> | null {
  if (ctx.jsonError) return null;
  return isRecord(ctx.json) ? ctx.json : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** The viewer as a GitHub user object. */
function viewerUser(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

function repoJson(ctx: ReqCtx, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(ctx: ReqCtx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: '',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: viewerUser(),
    comments: issue.comments.length,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function headBaseJson(ctx: ReqCtx, repo: Repo, pull: Pull): { head: Record<string, unknown>; base: Record<string, unknown> } {
  const headSha = ctx.store.branchTip(repo, pull.head) ?? '';
  const baseSha = ctx.store.branchTip(repo, pull.base) ?? '';
  return {
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
  };
}

function pullJson(ctx: ReqCtx, repo: Repo, pull: Pull): Record<string, unknown> {
  const { head, base } = headBaseJson(ctx, repo, pull);
  return {
    id: pull.id,
    node_id: '',
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head,
    base,
    user: viewerUser(),
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Paginate a list with GitHub-style Link headers. */
function paginate<T>(ctx: ReqCtx, items: readonly T[], toJson: (item: T) => unknown): Resp {
  const rawPerPage = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, Math.trunc(rawPerPage))) : 30;
  const rawPage = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const base = `${ctx.origin}${ctx.pathname}`;
  const links: string[] = [];
  if (page < pages) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  links.push(`<${base}?per_page=${perPage}&page=${pages}>; rel="last"`);
  return { status: 200, body: slice.map(toJson), headers: { link: links.join(', ') } };
}

/** Look a repository up; null when absent (any owner other than the viewer is a 404, never a 403). */
function findRepo(ctx: ReqCtx, owner: string, name: string): Repo | null {
  return ctx.store.getRepo(owner, name) ?? null;
}

function issueNumber(segment: string): number | null {
  const n = Number(segment);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The REST v3 router. Returns null when the path is not a REST route. */
export function handleRest(ctx: ReqCtx): Resp | null {
  const path = ctx.pathname;
  if (path === '/api/v3/' || path === '/api/v3') {
    if (ctx.method !== 'GET') return errorResp(405, 'Method Not Allowed');
    return {
      status: 200,
      body: {
        current_user_url: `${ctx.origin}/api/v3/user`,
        repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
        meta_url: `${ctx.origin}/api/v3/meta`,
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (path === '/api/v3/meta') {
    if (ctx.method !== 'GET') return errorResp(405, 'Method Not Allowed');
    return { status: 200, body: { installed_version: '1.0.0' } };
  }
  if (!path.startsWith('/api/v3/')) return null;
  const rest = path.slice('/api/v3/'.length);
  const segments = rest.split('/').map((s) => decodeURIComponent(s));

  // GET /user, GET /user/repos, POST /user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1 && ctx.method === 'GET') {
      return { status: 200, body: viewerUser() };
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (ctx.method === 'GET') {
        return paginate(ctx, ctx.store.listRepos(VIEWER_LOGIN), (repo) => repoJson(ctx, repo));
      }
      if (ctx.method === 'POST') {
        const body = bodyRecord(ctx);
        if (body === null) return errorResp(400, 'Invalid JSON body');
        const name = str(body.name);
        if (name === undefined || name === '') return errorResp(422, 'name is required');
        const created = ctx.store.createRepo(VIEWER_LOGIN, name, str(body.description) ?? '', bool(body.private) ?? false);
        if (created === null) return errorResp(422, 'Repository already exists');
        return { status: 201, body: repoJson(ctx, created) };
      }
      return errorResp(405, 'Method Not Allowed');
    }
    return notFound();
  }

  // /repos/{owner}/{name}[...]
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = findRepo(ctx, owner, name);
    if (repo === null) return notFound('Not Found');
    const tail = segments.slice(3);

    if (tail.length === 0) {
      if (ctx.method === 'GET') return { status: 200, body: repoJson(ctx, repo) };
      if (ctx.method === 'PATCH') {
        const body = bodyRecord(ctx);
        if (body === null) return errorResp(400, 'Invalid JSON body');
        const description = str(body.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = bool(body.private);
        if (isPrivate !== undefined) repo.privateFlag = isPrivate;
        return { status: 200, body: repoJson(ctx, repo) };
      }
      if (ctx.method === 'DELETE') {
        ctx.store.deleteRepo(owner, name);
        return { status: 204 };
      }
      return errorResp(405, 'Method Not Allowed');
    }

    if (tail[0] === 'branches') {
      if (tail.length === 1 && ctx.method === 'GET') {
        const branches: { name: string; commit: { sha: string } }[] = [];
        for (const [ref, oid] of [...repo.refs.entries()].sort()) {
          if (!ref.startsWith('refs/heads/')) continue;
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
        }
        return { status: 200, body: branches };
      }
      if (tail.length === 2 && ctx.method === 'GET') {
        const tip = ctx.store.branchTip(repo, tail[1] as string);
        if (tip === undefined) return notFound('Branch not found');
        return { status: 200, body: { name: tail[1], commit: { sha: tip }, protected: false } };
      }
      return notFound();
    }

    if (tail[0] === 'commits') {
      if (tail.length === 1 && ctx.method === 'GET') {
        const ref = ctx.query.get('sha') ?? undefined;
        const commits = ctx.store.listCommits(repo, ref);
        return paginate(ctx, commits, (commit) => {
          const stamp = commit.author.match(/ (\d+) \+0000$/)?.[1];
          const date = stamp === undefined ? FIXED_DATE : new Date(Number(stamp) * 1000).toISOString();
          const authorName = commit.author.replace(/ <.*$/, '');
          return {
            sha: commit.sha,
            commit: {
              message: commit.message,
              author: { name: authorName, email: VIEWER_EMAIL, date },
              committer: { name: authorName, email: VIEWER_EMAIL, date },
            },
            author: { login: VIEWER_LOGIN },
            committer: { login: VIEWER_LOGIN },
          };
        });
      }
      return notFound();
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && ctx.method === 'POST') {
        const body = bodyRecord(ctx);
        if (body === null) return errorResp(400, 'Invalid JSON body');
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (ref === undefined || sha === undefined) return errorResp(422, 'ref and sha are required');
        if (!ref.startsWith('refs/')) return errorResp(422, 'ref must start with refs/');
        if (repo.refs.has(ref)) return errorResp(422, 'Reference already exists');
        const object = repo.objects.get(sha);
        if (object === undefined || object.type !== 'commit') return errorResp(422, 'sha is not a commit');
        repo.refs.set(ref, sha);
        return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
      }
      if (tail.length === 4 && tail[2] === 'heads' && ctx.method === 'GET') {
        const tip = ctx.store.branchTip(repo, tail[3] as string);
        if (tip === undefined) return notFound('Reference not found');
        return { status: 200, body: { ref: `refs/heads/${tail[3]}`, object: { sha: tip, type: 'commit' } } };
      }
      return notFound();
    }

    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (ctx.method === 'PUT') {
        const body = bodyRecord(ctx);
        if (body === null) return errorResp(400, 'Invalid JSON body');
        const message = str(body.message);
        const content = str(body.content);
        if (message === undefined || content === undefined) return errorResp(422, 'message and content are required');
        const result = ctx.store.putContent(repo, filePath, b64decode(content), message, str(body.branch), str(body.sha));
        if ('error' in result) return errorResp(result.status, result.error);
        return {
          status: result.status,
          body: {
            content: { name: filePath.split('/').pop(), path: filePath, sha: result.contentSha, size: b64decode(content).length, encoding: 'base64' },
            commit: { sha: result.commitSha },
          },
        };
      }
      if (ctx.method === 'GET') {
        const ref = ctx.query.get('ref') ?? undefined;
        const read = ctx.store.readContent(repo, filePath, ref);
        if (read === null) return notFound('Not Found');
        if (read.kind === 'file') {
          return {
            status: 200,
            body: {
              type: 'file',
              encoding: 'base64',
              size: read.size,
              name: filePath.split('/').pop(),
              path: filePath,
              sha: read.sha,
              content: b64encode(read.data),
            },
          };
        }
        return {
          status: 200,
          body: read.entries.map((entry) => ({
            type: entry.type,
            name: entry.name,
            path: entry.path,
            sha: entry.sha,
            size: entry.size,
          })),
        };
      }
      if (ctx.method === 'DELETE') {
        const body = bodyRecord(ctx);
        if (body === null) return errorResp(400, 'Invalid JSON body');
        const result = ctx.store.deleteContent(repo, filePath, str(body.message) ?? '', str(body.branch), str(body.sha));
        if ('error' in result) return errorResp(result.status, result.error);
        return { status: 200, body: { commit: { sha: result.commitSha } } };
      }
      return errorResp(405, 'Method Not Allowed');
    }

    if (tail[0] === 'labels') {
      if (tail.length === 1 && ctx.method === 'POST') {
        const body = bodyRecord(ctx);
        if (body === null) return errorResp(400, 'Invalid JSON body');
        const name = str(body.name);
        if (name === undefined || name === '') return errorResp(422, 'name is required');
        const existing = repo.labels.get(name);
        if (existing !== undefined) return { status: 201, body: labelJson(existing) };
        const label: Label = { name, color: str(body.color) ?? 'ededed', description: str(body.description) ?? '' };
        repo.labels.set(name, label);
        return { status: 201, body: labelJson(label) };
      }
      if (tail.length === 1 && ctx.method === 'GET') {
        return { status: 200, body: [...repo.labels.values()].map(labelJson) };
      }
      return notFound();
    }

    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (ctx.method === 'POST') {
          const body = bodyRecord(ctx);
          if (body === null) return errorResp(400, 'Invalid JSON body');
          const title = str(body.title);
          if (title === undefined) return errorResp(422, 'title is required');
          const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
          const created = ctx.store.createIssue(repo, title, str(body.body) ?? '', labels);
          if ('error' in created) return errorResp(422, created.error);
          return { status: 201, body: issueJson(ctx, repo, created.issue) };
        }
        if (ctx.method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          return paginate(ctx, list, (issue) => issueJson(ctx, repo, issue));
        }
        return errorResp(405, 'Method Not Allowed');
      }
      const number = issueNumber(tail[1] as string);
      if (number === null) return notFound();
      if (tail.length === 2) {
        const issue = ctx.store.getIssue(repo, number);
        if (issue === undefined) return notFound('Issue not found');
        if (ctx.method === 'GET') return { status: 200, body: issueJson(ctx, repo, issue) };
        if (ctx.method === 'PATCH') {
          const body = bodyRecord(ctx);
          if (body === null) return errorResp(400, 'Invalid JSON body');
          const state = str(body.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = str(body.title);
          if (title !== undefined) issue.title = title;
          const bodyText = str(body.body);
          if (bodyText !== undefined) issue.body = bodyText;
          return { status: 200, body: issueJson(ctx, repo, issue) };
        }
        return errorResp(405, 'Method Not Allowed');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        const issue = ctx.store.getIssue(repo, number);
        if (issue === undefined) return notFound('Issue not found');
        if (ctx.method === 'POST') {
          const body = bodyRecord(ctx);
          if (body === null) return errorResp(400, 'Invalid JSON body');
          const text = str(body.body);
          if (text === undefined) return errorResp(422, 'body is required');
          const comment = { id: ctx.store.nextCommentId(), body: text };
          issue.comments.push(comment);
          return {
            status: 201,
            body: { id: comment.id, body: comment.body, user: viewerUser(), created_at: FIXED_DATE },
          };
        }
        if (ctx.method === 'GET') {
          return {
            status: 200,
            body: issue.comments.map((comment) => ({
              id: comment.id,
              body: comment.body,
              user: viewerUser(),
              created_at: FIXED_DATE,
            })),
          };
        }
        return errorResp(405, 'Method Not Allowed');
      }
      return notFound();
    }

    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (ctx.method === 'POST') {
          const body = bodyRecord(ctx);
          if (body === null) return errorResp(400, 'Invalid JSON body');
          const head = str(body.head);
          const base = str(body.base);
          const title = str(body.title);
          if (head === undefined || base === undefined || title === undefined) return errorResp(422, 'head, base and title are required');
          const created = ctx.store.createPull(repo, head, base, title, str(body.body) ?? '');
          if ('error' in created) return errorResp(422, created.error);
          return { status: 201, body: pullJson(ctx, repo, created.pull) };
        }
        if (ctx.method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((pull) => pull.state === state);
          list.sort((a, b) => b.seq - a.seq);
          return paginate(ctx, list, (pull) => pullJson(ctx, repo, pull));
        }
        return errorResp(405, 'Method Not Allowed');
      }
      const number = issueNumber(tail[1] as string);
      if (number === null) return notFound();
      const pull = ctx.store.getPull(repo, number);
      if (tail.length === 2) {
        if (pull === undefined) return notFound('Pull request not found');
        if (ctx.method === 'GET') return { status: 200, body: pullJson(ctx, repo, pull) };
        return errorResp(405, 'Method Not Allowed');
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (pull === undefined) return notFound('Pull request not found');
        if (ctx.method !== 'GET') return errorResp(405, 'Method Not Allowed');
        const files = ctx.store.pullFiles(repo, pull);
        return {
          status: 200,
          body: files.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          })),
        };
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (pull === undefined) return notFound('Pull request not found');
        if (ctx.method !== 'PUT') return errorResp(405, 'Method Not Allowed');
        const merged = ctx.store.mergePull(repo, pull);
        if ('error' in merged) {
          if (merged.error === 'merge conflict') return errorResp(405, 'Merge conflict');
          return errorResp(422, merged.error);
        }
        return { status: 200, body: { sha: merged.sha, merged: true, message: 'Pull request successfully merged.' } };
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}
