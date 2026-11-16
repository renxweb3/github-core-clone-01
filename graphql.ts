// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send (see checks-graphql.ts's GRAPHQL_DOCUMENTS): viewer,
// repository reads, issue/pull-request reads, __type introspection, node(id:),
// the five mutations, and operation batching at the HTTP layer. Written from
// scratch in-session: a tokenizer, a recursive-descent parser for the
// operation/selection/argument grammar, and resolvers over the store.
// An unknown field is a 200 with an `errors` array naming the field (never
// an HTTP error), per the GraphQL wire rules.

import { b64urlEncode, b64urlDecode } from './util.ts';
import {
  VIEWER_LOGIN,
  type Repo,
  type Issue,
  type Pull,
  type IssueComment,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  decodeGlobalId,
} from './store.ts';
import type { Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1] as string;
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else value += next;
          i += 2;
          continue;
        }
        value += input[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        let k = j + 1;
        if (input[k] === '+' || input[k] === '-') k += 1;
        if (/[0-9]/.test(input[k] ?? '')) {
          j = k;
          while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
        }
      }
      tokens.push({ kind: 'number', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export interface GqlField {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly selection: GqlSelection[] | null;
}

export type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'fragment'; typeCondition: string | null; selection: GqlSelection[] };

export interface GqlOperation {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selection: GqlSelection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;

  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected a directive name');
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token !== undefined && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = token.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') {
        name = maybeName.value;
        this.next();
      }
    } else if (token !== undefined && token.kind === 'name') {
      name = token.value;
      this.next();
    }
    if (this.isPunct('(')) this.skipVariableDefinitions();
    this.skipDirectives();
    const selection = this.parseSelectionSet();
    return { type, name, selection };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.isPunct('}')) {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.isPunct('...')) {
      this.next();
      let typeCondition: string | null = null;
      const token = this.peek();
      if (token !== undefined && token.kind === 'name' && token.value === 'on') {
        this.next();
        const name = this.next();
        if (name.kind !== 'name') throw new Error('expected a type name after ... on');
        typeCondition = name.value;
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      const real = this.next();
      if (real.kind !== 'name') throw new Error('expected a field name after an alias');
      name = real.value;
    }
    let args: Record<string, unknown> = {};
    if (this.isPunct('(')) args = this.parseArguments();
    this.skipDirectives();
    let selection: GqlSelection[] | null = null;
    if (this.isPunct('{')) selection = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (!this.isPunct(')')) {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected an argument name');
      this.expectPunct(':');
      args[name.value] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected a variable name after $');
      return this.variables[name.value] ?? null;
    }
    if (token.kind === 'string' || token.kind === 'number') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const name = this.next();
        if (name.kind !== 'name') throw new Error('expected an object field name');
        this.expectPunct(':');
        object[name.value] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlCtx {
  readonly store: Store;
}

interface Resolved {
  /** The GraphQL type of the value (null for scalars and for a null value). */
  readonly kind: string | null;
  readonly value: unknown;
}

/** An issue together with the repo that owns it (global ids need both). */
interface IssueValue {
  readonly repo: Repo;
  readonly issue: Issue;
}

/** A pull request together with the repo that owns it. */
interface PullValue {
  readonly repo: Repo;
  readonly pull: Pull;
}

/** A comment together with its issue and repo. */
interface CommentValue {
  readonly repo: Repo;
  readonly issue: Issue;
  readonly comment: IssueComment;
}

interface TypeInfo {
  readonly name: string;
  readonly fields: string[] | null;
  readonly enumValues: string[] | null;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
];

const KNOWN_TYPES: Record<string, TypeInfo> = {
  Issue: { name: 'Issue', fields: ISSUE_FIELDS, enumValues: null },
  PullRequest: { name: 'PullRequest', fields: PULL_REQUEST_FIELDS, enumValues: null },
  Repository: { name: 'Repository', fields: REPOSITORY_FIELDS, enumValues: null },
  SearchType: { name: 'SearchType', fields: null, enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
}

function issueCursor(number: number): string {
  return b64urlEncode(Buffer.from(`IssueCursor:${number}`, 'utf8'));
}

function parseIssueCursor(cursor: string): number | null {
  try {
    const decoded = b64urlDecode(cursor).toString('utf8');
    const match = /^IssueCursor:(\d+)$/.exec(decoded);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Sort issues per the query's orderBy, defaulting to CREATED_AT DESC (newest first). */
function sortedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  const list = [...repo.issues];
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const states = Array.isArray(args.states) ? args.states : null;
  const filtered = states === null ? list : list.filter((issue) => states.includes(issue.state.toUpperCase()));
  return filtered;
}

function resolveNode(ctx: GqlCtx, id: string): Resolved | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    return repo === undefined ? null : { kind: 'Repository', value: repo };
  }
  if (decoded.kind === 'Issue') {
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    const issue = repo === undefined ? undefined : ctx.store.getIssue(repo, decoded.number);
    return issue === undefined ? null : { kind: 'Issue', value: { repo, issue } };
  }
  if (decoded.kind === 'PullRequest') {
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    const pull = repo === undefined ? undefined : ctx.store.getPull(repo, decoded.number);
    return pull === undefined ? null : { kind: 'PullRequest', value: { repo, pull } };
  }
  return null;
}

/**
 * Resolve one field of a parent object. Returns null when the field is
 * unknown on this type (the caller turns that into an errors entry).
 */
function resolveField(ctx: GqlCtx, kind: string, value: unknown, field: GqlField): Resolved | null {
  const args = field.args;
  switch (kind) {
    case 'Query': {
      if (field.name === 'viewer') return { kind: 'User', value: { login: VIEWER_LOGIN } };
      if (field.name === 'repository') {
        const owner = argStr(args, 'owner');
        const name = argStr(args, 'name');
        if (owner === undefined || name === undefined) return { kind: null, value: null };
        const repo = ctx.store.getRepo(owner, name);
        return repo === undefined ? { kind: null, value: null } : { kind: 'Repository', value: repo };
      }
      if (field.name === 'node') {
        const id = argStr(args, 'id');
        if (id === undefined) return { kind: null, value: null };
        const resolved = resolveNode(ctx, id);
        return resolved === null ? { kind: null, value: null } : resolved;
      }
      if (field.name === '__type') {
        const name = argStr(args, 'name');
        const info = name === undefined ? undefined : KNOWN_TYPES[name];
        return info === undefined ? { kind: null, value: null } : { kind: '__Type', value: info };
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const repoId = argStr(input, 'repositoryId');
        const title = argStr(input, 'title');
        if (repoId === undefined || title === undefined) return { kind: null, value: null };
        const decoded = decodeGlobalId(repoId);
        if (decoded === null || decoded.kind !== 'Repository') return { kind: null, value: null };
        const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
        if (repo === undefined) return { kind: null, value: null };
        const created = ctx.store.createIssue(repo, title, argStr(input, 'body') ?? '', []);
        if ('error' in created) return { kind: null, value: null };
        return { kind: 'CreateIssuePayload', value: { issue: { repo, issue: created.issue } } };
      }
      if (field.name === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const issueId = argStr(input, 'issueId');
        if (issueId === undefined) return { kind: null, value: null };
        const resolved = resolveNode(ctx, issueId);
        if (resolved === null || resolved.kind !== 'Issue') return { kind: null, value: null };
        (resolved.value as IssueValue).issue.state = 'closed';
        return { kind: 'CloseIssuePayload', value: { issue: resolved.value as IssueValue } };
      }
      if (field.name === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const repoId = argStr(input, 'repositoryId');
        const base = argStr(input, 'baseRefName');
        const head = argStr(input, 'headRefName');
        const title = argStr(input, 'title');
        if (repoId === undefined || base === undefined || head === undefined || title === undefined) {
          return { kind: null, value: null };
        }
        const decoded = decodeGlobalId(repoId);
        if (decoded === null || decoded.kind !== 'Repository') return { kind: null, value: null };
        const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
        if (repo === undefined) return { kind: null, value: null };
        const created = ctx.store.createPull(repo, head, base, title, argStr(input, 'body') ?? '');
        if ('error' in created) return { kind: null, value: null };
        return { kind: 'CreatePullRequestPayload', value: { pull: { repo, pull: created.pull } } };
      }
      if (field.name === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const pullId = argStr(input, 'pullRequestId');
        if (pullId === undefined) return { kind: null, value: null };
        const resolved = resolveNode(ctx, pullId);
        if (resolved === null || resolved.kind !== 'PullRequest') return { kind: null, value: null };
        const pullValue = resolved.value as PullValue;
        const merged = ctx.store.mergePull(pullValue.repo, pullValue.pull);
        if ('error' in merged) return { kind: null, value: null };
        return { kind: 'MergePullRequestPayload', value: { pull: pullValue } };
      }
      if (field.name === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const subjectId = argStr(input, 'subjectId');
        const body = argStr(input, 'body');
        if (subjectId === undefined || body === undefined) return { kind: null, value: null };
        const resolved = resolveNode(ctx, subjectId);
        if (resolved === null || resolved.kind !== 'Issue') return { kind: null, value: null };
        const issueValue = resolved.value as IssueValue;
        const comment = { id: ctx.store.nextCommentId(), body };
        issueValue.issue.comments.push(comment);
        return { kind: 'AddCommentPayload', value: { comment: { repo: issueValue.repo, issue: issueValue.issue, comment } } };
      }
      return null;
    }
    case 'User': {
      if (field.name === 'login') return { kind: null, value: (value as { login: string }).login };
      return null;
    }
    case 'Repository': {
      const repo = value as Repo;
      if (field.name === 'id') return { kind: null, value: repoGlobalId(repo) };
      if (field.name === 'databaseId') return { kind: null, value: repo.id };
      if (field.name === 'name') return { kind: null, value: repo.name };
      if (field.name === 'nameWithOwner') return { kind: null, value: `${repo.owner}/${repo.name}` };
      if (field.name === 'owner') return { kind: 'User', value: { login: repo.owner } };
      if (field.name === 'defaultBranchRef') {
        const tip = ctx.store.branchTip(repo, repo.defaultBranch);
        return tip === undefined ? { kind: null, value: null } : { kind: 'Ref', value: { name: repo.defaultBranch } };
      }
      if (field.name === 'viewerPermission') return { kind: null, value: 'ADMIN' };
      if (field.name === 'hasIssuesEnabled') return { kind: null, value: true };
      if (field.name === 'issue') {
        const number = argNum(args, 'number');
        if (number === undefined) return { kind: null, value: null };
        const issue = ctx.store.getIssue(repo, number);
        return issue === undefined ? { kind: null, value: null } : { kind: 'Issue', value: { repo, issue } };
      }
      if (field.name === 'issues') {
        const all = sortedIssues(repo, args);
        const after = argStr(args, 'after');
        let start = 0;
        if (after !== undefined) {
          const cursorNumber = parseIssueCursor(after);
          if (cursorNumber !== null) {
            const index = all.findIndex((issue) => issue.number === cursorNumber);
            if (index >= 0) start = index + 1;
          }
        }
        const first = argNum(args, 'first');
        const page = first === undefined ? all.slice(start) : all.slice(start, start + first);
        const hasNextPage = start + page.length < all.length;
        const endCursor = page.length === 0 ? null : issueCursor(page[page.length - 1]?.number ?? 0);
        return {
          kind: 'IssueConnection',
          value: { nodes: page.map((issue) => ({ repo, issue })), pageInfo: { hasNextPage, endCursor } },
        };
      }
      if (field.name === 'pullRequests') {
        const first = argNum(args, 'first');
        const open = [...repo.pulls].filter((pull) => pull.state === 'open').sort((a, b) => b.seq - a.seq);
        const page = first === undefined ? open : open.slice(0, first);
        return { kind: 'PullRequestConnection', value: { nodes: page.map((pull) => ({ repo, pull })) } };
      }
      if (field.name === 'pullRequest') {
        const number = argNum(args, 'number');
        if (number === undefined) return { kind: null, value: null };
        const pull = ctx.store.getPull(repo, number);
        return pull === undefined ? { kind: null, value: null } : { kind: 'PullRequest', value: { repo, pull } };
      }
      return null;
    }
    case 'Issue': {
      const { repo, issue } = value as IssueValue;
      if (field.name === 'id') return { kind: null, value: issueGlobalId(repo, issue) };
      if (field.name === 'number') return { kind: null, value: issue.number };
      if (field.name === 'title') return { kind: null, value: issue.title };
      if (field.name === 'state') return { kind: null, value: issue.state.toUpperCase() };
      if (field.name === 'body') return { kind: null, value: issue.body };
      return null;
    }
    case 'PullRequest': {
      const { repo, pull } = value as PullValue;
      if (field.name === 'id') return { kind: null, value: pullGlobalId(repo, pull) };
      if (field.name === 'number') return { kind: null, value: pull.number };
      if (field.name === 'state') {
        return { kind: null, value: pull.merged ? 'MERGED' : pull.state.toUpperCase() };
      }
      if (field.name === 'merged') return { kind: null, value: pull.merged };
      if (field.name === 'headRefName') return { kind: null, value: pull.head };
      if (field.name === 'baseRefName') return { kind: null, value: pull.base };
      if (field.name === 'mergeable') {
        if (pull.state !== 'open') return { kind: null, value: 'UNKNOWN' };
        return { kind: null, value: ctx.store.mergeableOf(repo, pull) === 'MERGEABLE' ? 'MERGEABLE' : 'CONFLICTING' };
      }
      if (field.name === 'files') {
        const files = ctx.store.pullFiles(repo, pull).map((file) => ({ path: file.filename }));
        const first = argNum(args, 'first');
        const page = first === undefined ? files : files.slice(0, first);
        return { kind: 'PullRequestFileConnection', value: { nodes: page } };
      }
      return null;
    }
    case 'IssueConnection': {
      const connection = value as { nodes: IssueValue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') return { kind: 'Issue', value: connection.nodes };
      if (field.name === 'pageInfo') return { kind: 'PageInfo', value: connection.pageInfo };
      return null;
    }
    case 'PullRequestConnection': {
      const connection = value as { nodes: PullValue[] };
      if (field.name === 'nodes') return { kind: 'PullRequest', value: connection.nodes };
      return null;
    }
    case 'PullRequestFileConnection': {
      const connection = value as { nodes: { path: string }[] };
      if (field.name === 'nodes') return { kind: 'PullRequestChangedFile', value: connection.nodes };
      return null;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return { kind: null, value: (value as { path: string }).path };
      return null;
    }
    case 'PageInfo': {
      const pageInfo = value as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return { kind: null, value: pageInfo.hasNextPage };
      if (field.name === 'endCursor') return { kind: null, value: pageInfo.endCursor };
      return null;
    }
    case 'Ref': {
      if (field.name === 'name') return { kind: null, value: (value as { name: string }).name };
      return null;
    }
    case '__Type': {
      const info = value as TypeInfo;
      if (field.name === 'name') return { kind: null, value: info.name };
      if (field.name === 'fields') {
        return info.fields === null ? { kind: null, value: null } : { kind: '__Field', value: info.fields.map((name) => ({ name })) };
      }
      if (field.name === 'enumValues') {
        return info.enumValues === null ? { kind: null, value: null } : { kind: '__EnumValue', value: info.enumValues.map((name) => ({ name })) };
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return { kind: null, value: (value as { name: string }).name };
      return null;
    }
    case 'CreateIssuePayload': {
      const payload = value as { issue: IssueValue };
      if (field.name === 'issue') return { kind: 'Issue', value: payload.issue };
      return null;
    }
    case 'CloseIssuePayload': {
      const payload = value as { issue: IssueValue };
      if (field.name === 'issue') return { kind: 'Issue', value: payload.issue };
      return null;
    }
    case 'CreatePullRequestPayload': {
      const payload = value as { pull: PullValue };
      if (field.name === 'pullRequest') return { kind: 'PullRequest', value: payload.pull };
      return null;
    }
    case 'MergePullRequestPayload': {
      const payload = value as { pull: PullValue };
      if (field.name === 'pullRequest') return { kind: 'PullRequest', value: payload.pull };
      return null;
    }
    case 'AddCommentPayload': {
      const payload = value as { comment: CommentValue };
      if (field.name === 'commentEdge') return { kind: 'CommentEdge', value: { node: payload.comment } };
      return null;
    }
    case 'CommentEdge': {
      const edge = value as { node: CommentValue };
      if (field.name === 'node') return { kind: 'Comment', value: edge.node };
      return null;
    }
    case 'Comment': {
      const commentValue = value as CommentValue;
      if (field.name === 'id') return { kind: null, value: commentGlobalId(commentValue.repo, commentValue.issue, commentValue.comment) };
      if (field.name === 'body') return { kind: null, value: commentValue.comment.body };
      return null;
    }
    default:
      return null;
  }
}

/** Execute a selection set against a value of the given kind. Returns null on an unknown field. */
function executeSelection(
  ctx: GqlCtx,
  kind: string,
  value: unknown,
  selection: GqlSelection[],
  errors: { message: string }[],
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'fragment') {
      if (item.typeCondition !== null && item.typeCondition !== kind) continue;
      const nested = executeSelection(ctx, kind, value, item.selection, errors);
      if (nested === null) return null;
      Object.assign(result, nested);
      continue;
    }
    const field = item.field;
    const resolved = resolveField(ctx, kind, value, field);
    if (resolved === null) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${kind}".` });
      return null;
    }
    const key = field.alias ?? field.name;
    if (field.selection === null) {
      result[key] = resolved.value;
      continue;
    }
    if (resolved.value === null) {
      result[key] = null;
      continue;
    }
    if (Array.isArray(resolved.value)) {
      if (resolved.kind === null) {
        result[key] = resolved.value;
        continue;
      }
      const items: unknown[] = [];
      for (const element of resolved.value) {
        const selected = executeSelection(ctx, resolved.kind, element, field.selection, errors);
        if (selected === null) return null;
        items.push(selected);
      }
      result[key] = items;
      continue;
    }
    if (resolved.kind === null) {
      result[key] = resolved.value;
      continue;
    }
    const nested = executeSelection(ctx, resolved.kind, resolved.value, field.selection, errors);
    if (nested === null) return null;
    result[key] = nested;
  }
  return result;
}

/** Execute one GraphQL operation against the store. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: unknown; errors?: { message: string }[] } {
  let operations: GqlOperation[];
  try {
    operations = new Parser(tokenize(query), variables).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL parse error' }] };
  }
  let operation = operations[0];
  if (operationName !== undefined) {
    const named = operations.find((op) => op.name === operationName);
    if (named !== undefined) operation = named;
  }
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation provided' }] };
  const ctx: GqlCtx = { store };
  const errors: { message: string }[] = [];
  const rootKind = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootKind, null, operation.selection, errors);
  if (errors.length > 0) return { data: null, errors };
  return { data };
}
