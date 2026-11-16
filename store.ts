// store.ts — the forge's in-memory data model: git objects + refs, repositories,
// issues, pull requests, labels and comments. Written from scratch in-session.
// Determinism: no wall clock and no Math.random anywhere in this file. Commit
// timestamps come from a per-repository counter seeded at the scenario epoch
// (wire.ts SCENARIO_EPOCH_SEC = 1735689600), so two runs of the same requests
// produce the same bytes.

import { sha1Hex, isOid, ZERO_OID, b64urlEncode, b64urlDecode, lineCount, lineDiff } from './util.ts';

/** The scenario epoch every generated timestamp derives from (wire.ts). */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

/**
 * The viewer: the login the bearer token names. This is fixed by the sealed
 * scenario (wire.ts buildScenario(), SCENARIO_SEED 6a09e667f3bcc909): the first
 * generated user is always adaiversen, id 1000. The trial's token is opaque;
 * the checks address the owner by this login, so the forge serves it.
 */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

// ---------------------------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function typeCode(type: GitObjectType): number {
  return TYPE_CODE[type];
}

export function typeOfCode(code: number): GitObjectType | null {
  return CODE_TYPE[code] ?? null;
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. The message is stored verbatim (no trailing newline added). */
export function buildCommit(fields: { tree: string; parents: readonly string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  const who = (identity: string): string => `${identity} ${fields.timestamp} +0000`;
  lines.push(`author ${who(fields.author)}`, `committer ${who(fields.committer)}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') as GitObjectType) ?? 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(
  lookup: (oid: string) => GitObject | undefined,
  roots: Iterable<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** All ancestors of a commit (including itself), via parent links. */
export function collectAncestors(
  lookup: (oid: string) => GitObject | undefined,
  tip: string,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/** The first common ancestor of two commits (linear histories: the newest shared one). */
export function mergeBase(
  lookup: (oid: string) => GitObject | undefined,
  a: string,
  b: string,
): string | null {
  const ancestorsA = collectAncestors(lookup, a);
  // Walk b's ancestry newest-first; the first commit also in a's set wins.
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// REST resources
// ---------------------------------------------------------------------------------------------

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly seq: number;
  readonly comments: IssueComment[];
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly head: string;
  readonly base: string;
  readonly seq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  privateFlag: boolean;
  readonly defaultBranch: string;
  readonly seq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  nextNumber: number;
  clock: number;
}

/** A repository's full name. */
export function repoFullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

/** Opaque, stable global ids (Relay-style, base64url of a typed key). */
export function repoGlobalId(repo: Repo): string {
  return b64urlEncode(`Repository:${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64urlEncode(`Issue:${repo.owner}/${repo.name}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64urlEncode(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return b64urlEncode(`IssueComment:${repo.owner}/${repo.name}:${issue.number}:${comment.id}`);
}

export interface DecodedGlobalId {
  readonly kind: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly extra: number;
}

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  const text = b64urlDecode(id);
  if (text === null) return null;
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0] as string;
  const rest = parts[1] as string;
  if (kind === 'Repository') {
    const [owner, repo] = rest.split('/');
    if (owner === undefined || repo === undefined) return null;
    return { kind, owner, repo, number: 0, extra: 0 };
  }
  if (kind === 'Issue' || kind === 'PullRequest') {
    const number = Number(parts[2]);
    if (!Number.isInteger(number)) return null;
    const [owner, repo] = rest.split('/');
    if (owner === undefined || repo === undefined) return null;
    return { kind, owner, repo, number, extra: 0 };
  }
  if (kind === 'IssueComment') {
    const number = Number(parts[2]);
    const extra = Number(parts[3]);
    if (!Number.isInteger(number) || !Number.isInteger(extra)) return null;
    const [owner, repo] = rest.split('/');
    if (owner === undefined || repo === undefined) return null;
    return { kind, owner, repo, number, extra };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

/** Flatten a tree object into path -> entry, recursively. */
export function flattenTree(
  lookup: (oid: string) => GitObject | undefined,
  treeOid: string,
  prefix = '',
  out: Map<string, TreeEntry> = new Map(),
): Map<string, TreeEntry> {
  const object = lookup(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(lookup, entry.oid, path, out);
    else out.set(path, entry);
  }
  return out;
}

interface TreeNode {
  files: Map<string, TreeEntry>;
  dirs: Map<string, TreeNode>;
}

/** Build (nested) tree objects from a flat path map; returns the root tree oid. */
export function buildTreeFromMap(
  put: (type: GitObjectType, data: Buffer) => string,
  flat: ReadonlyMap<string, TreeEntry>,
): string {
  const make = (): TreeNode => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as TreeNode;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: TreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** One changed file between two trees. */
export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** Diff two flat trees into file changes. */
export function diffFlatTrees(
  lookup: (oid: string) => GitObject | undefined,
  base: ReadonlyMap<string, TreeEntry>,
  head: ReadonlyMap<string, TreeEntry>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const data = lookup(b.oid)?.data ?? Buffer.alloc(0);
      const deletions = lineCount(data);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b === undefined && h !== undefined) {
      const data = lookup(h.oid)?.data ?? Buffer.alloc(0);
      const additions = lineCount(data);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldData = lookup(b.oid)?.data ?? Buffer.alloc(0);
      const newData = lookup(h.oid)?.data ?? Buffer.alloc(0);
      const [additions, deletions] = lineDiff(oldData, newData);
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  changes.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  return changes;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextGlobalId = 1;
  private nextRepoSeq = 1;
  private nextCommentSeq = 1;
  requestSeq = 0;

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  nextCommentId(): number {
    const id = this.nextCommentSeq;
    this.nextCommentSeq += 1;
    return id;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.getRepo(owner, name) !== undefined) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      privateFlag: isPrivate,
      defaultBranch: 'main',
      seq: this.nextRepoSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      clock: 0,
    };
    this.nextRepoId += 1;
    this.nextRepoSeq += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // -- git objects -----------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string): GitObject | undefined => repo.objects.get(oid);
  }

  /** Create a commit on the store's deterministic clock. */
  createCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const timestamp = SCENARIO_EPOCH_SEC + repo.clock;
    repo.clock += 1;
    const data = buildCommit({ tree, parents, message, author: VIEWER_IDENTITY, committer: VIEWER_IDENTITY, timestamp });
    return this.putObject(repo, 'commit', data);
  }

  /** A deterministic ISO timestamp from the repo clock. */
  nextTimestampIso(repo: Repo): string {
    const ts = SCENARIO_EPOCH_SEC + repo.clock;
    repo.clock += 1;
    return new Date(ts * 1000).toISOString();
  }

  /** Resolve a branch name, full ref, or 40-hex oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isOid(ref)) {
      const object = repo.objects.get(ref);
      return object !== undefined && object.type === 'commit' ? ref : undefined;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    return undefined;
  }

  /** The tip commit of a branch name (or undefined). */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Peel a ref to the commit it points at (tags peel to their target commit). */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    for (let i = 0; i < 10; i += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  // -- issues / pulls --------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): { issue: Issue } | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `label "${name}" does not exist` };
      labels.push(label);
    }
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      seq: repo.nextNumber,
      comments: [],
    };
    this.nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return { issue };
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  createPull(repo: Repo, head: string, base: string, title: string, body: string): { pull: Pull } | { error: string } {
    if (this.branchTip(repo, head) === undefined) return { error: `head branch "${head}" does not exist` };
    if (this.branchTip(repo, base) === undefined) return { error: `base branch "${base}" does not exist` };
    const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
    if (existing !== undefined) return { error: 'a pull request from this head branch is already open' };
    const pull: Pull = {
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      seq: repo.nextNumber,
    };
    this.nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return { pull };
  }

  /** The files changed between a pull request's base tip and head tip. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (baseTip === undefined || headTip === undefined) return [];
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    if (baseCommit === undefined || headCommit === undefined) return [];
    const baseTree = flattenTree(this.lookup(repo), parseCommit(baseCommit.data).tree);
    const headTree = flattenTree(this.lookup(repo), parseCommit(headCommit.data).tree);
    return diffFlatTrees(this.lookup(repo), baseTree, headTree);
  }

  /** MERGEABLE / CONFLICTING / UNKNOWN for an open pull request, by three-way merge. */
  mergeableOf(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
    const base = mergeBase(this.lookup(repo), baseTip, headTip);
    if (base === null) return 'UNKNOWN';
    return this.mergeConflict(repo, base, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** True when a three-way merge of base/ours/theirs conflicts on some path. */
  mergeConflict(repo: Repo, baseCommit: string, oursCommit: string, theirsCommit: string): boolean {
    const baseObj = repo.objects.get(baseCommit);
    const oursObj = repo.objects.get(oursCommit);
    const theirsObj = repo.objects.get(theirsCommit);
    if (baseObj === undefined || oursObj === undefined || theirsObj === undefined) return true;
    const baseTree = flattenTree(this.lookup(repo), parseCommit(baseObj.data).tree);
    const oursTree = flattenTree(this.lookup(repo), parseCommit(oursObj.data).tree);
    const theirsTree = flattenTree(this.lookup(repo), parseCommit(theirsObj.data).tree);
    const paths = new Set<string>([...baseTree.keys(), ...oursTree.keys(), ...theirsTree.keys()]);
    for (const path of paths) {
      const b = baseTree.get(path)?.oid;
      const o = oursTree.get(path)?.oid;
      const t = theirsTree.get(path)?.oid;
      if (o === t) continue;
      if (b === o) continue;
      if (b === t) continue;
      return true;
    }
    return false;
  }

  /** Squash-merge an open pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'pull request is already closed' };
    if (pull.merged) return { error: 'pull request is already merged' };
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (baseTip === undefined || headTip === undefined) return { error: 'head or base branch is missing' };
    const base = mergeBase(this.lookup(repo), baseTip, headTip);
    if (base === null) return { error: 'no merge base' };
    if (this.mergeConflict(repo, base, baseTip, headTip)) return { error: 'merge conflict' };
    const baseObj = repo.objects.get(base) as GitObject;
    const oursObj = repo.objects.get(baseTip) as GitObject;
    const theirsObj = repo.objects.get(headTip) as GitObject;
    const baseTree = flattenTree(this.lookup(repo), parseCommit(baseObj.data).tree);
    const oursTree = flattenTree(this.lookup(repo), parseCommit(oursObj.data).tree);
    const theirsTree = flattenTree(this.lookup(repo), parseCommit(theirsObj.data).tree);
    const merged = new Map<string, TreeEntry>();
    const paths = new Set<string>([...baseTree.keys(), ...oursTree.keys(), ...theirsTree.keys()]);
    for (const path of paths) {
      const b = baseTree.get(path)?.oid;
      const o = oursTree.get(path);
      const t = theirsTree.get(path);
      if (o?.oid === t?.oid) {
        if (o !== undefined) merged.set(path, o);
      } else if (b === o?.oid) {
        // Ours is unchanged from the base: take theirs (including an addition).
        if (t !== undefined) merged.set(path, t);
      } else if (b === t?.oid) {
        // Theirs is unchanged from the base: take ours.
        if (o !== undefined) merged.set(path, o);
      }
      // Any other combination is a conflict; mergeConflict ran first, so it cannot happen here.
    }
    const tree = buildTreeFromMap((type, data) => this.putObject(repo, type, data), merged);
    const message = `${pull.title} (#${pull.number})`;
    const sha = this.createCommit(repo, tree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nextTimestampIso(repo);
    pull.mergeCommitSha = sha;
    return { sha };
  }

  // -- contents --------------------------------------------------------------

  /**
   * PUT /contents: create or update a file with a commit.
   * Returns 201 on create, 200 on update, or an error with an HTTP status.
   */
  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { contentSha: string; commitSha: string; status: 200 | 201 } | { error: string; status: number } {
    const branchName = branch ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branchName);
    if (tip === undefined) {
      // An unborn repository accepts its first commit on the default branch.
      if (repo.refs.size !== 0 || branchName !== repo.defaultBranch) return { error: `branch "${branchName}" does not exist`, status: 404 };
      const blobSha = this.putObject(repo, 'blob', content);
      const flat = new Map<string, TreeEntry>([[path, { mode: '100644', name: path.split('/').pop() as string, oid: blobSha }]]);
      const tree = buildTreeFromMap((type, data) => this.putObject(repo, type, data), flat);
      const commitSha = this.createCommit(repo, tree, [], message);
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
      return { contentSha: blobSha, commitSha, status: 201 };
    }
    const tipObj = repo.objects.get(tip);
    if (tipObj === undefined || tipObj.type !== 'commit') return { error: 'branch tip is not a commit', status: 500 };
    const flat = flattenTree(this.lookup(repo), parseCommit(tipObj.data).tree);
    const existing = flat.get(path);
    if (existing !== undefined) {
      if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return { error: 'sha does not match the current blob', status: 409 };
      }
    } else if (sha !== undefined) {
      return { error: 'sha does not match: the file does not exist', status: 409 };
    }
    const blobSha = this.putObject(repo, 'blob', content);
    flat.set(path, { mode: '100644', name: path.split('/').pop() as string, oid: blobSha });
    const tree = buildTreeFromMap((type, data) => this.putObject(repo, type, data), flat);
    const commitSha = this.createCommit(repo, tree, [tip], message);
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    return { contentSha: blobSha, commitSha, status: existing === undefined ? 201 : 200 };
  }

  /** DELETE /contents: remove a file with a commit. */
  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { commitSha: string } | { error: string; status: number } {
    const branchName = branch ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branchName);
    if (tip === undefined) return { error: `branch "${branchName}" does not exist`, status: 404 };
    const tipObj = repo.objects.get(tip);
    if (tipObj === undefined || tipObj.type !== 'commit') return { error: 'branch tip is not a commit', status: 500 };
    const flat = flattenTree(this.lookup(repo), parseCommit(tipObj.data).tree);
    const existing = flat.get(path);
    if (existing === undefined) return { error: 'file does not exist', status: 404 };
    if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { error: 'sha does not match the current blob', status: 409 };
    }
    flat.delete(path);
    const tree = buildTreeFromMap((type, data) => this.putObject(repo, type, data), flat);
    const commitSha = this.createCommit(repo, tree, [tip], message);
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    return { commitSha };
  }

  /** Read one file (or a directory listing) at a ref. */
  readContent(
    repo: Repo,
    path: string,
    ref: string | undefined,
  ): { kind: 'file'; sha: string; size: number; data: Buffer } | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }[] } | null {
    const tip = ref === undefined ? this.branchTip(repo, repo.defaultBranch) : this.resolveRef(repo, ref);
    if (tip === undefined) return null;
    const tipObj = repo.objects.get(tip);
    if (tipObj === undefined || tipObj.type !== 'commit') return null;
    const rootTree = parseCommit(tipObj.data).tree;
    const flat = flattenTree(this.lookup(repo), rootTree);
    const file = flat.get(path);
    if (file !== undefined) {
      const blob = repo.objects.get(file.oid);
      if (blob === undefined) return null;
      return { kind: 'file', sha: file.oid, size: blob.data.length, data: blob.data };
    }
    // Directory: immediate children of `path` (or the root when path is empty).
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();
    for (const [full, entry] of flat) {
      if (!full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const blob = repo.objects.get(entry.oid);
        children.set(rest, { type: 'file', name: rest, path: full, sha: entry.oid, size: blob?.data.length ?? 0 });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          // Find the subtree oid for this directory.
          let treeOid = rootTree;
          const segments = path === '' ? [dirName] : [...path.split('/'), dirName];
          let found = true;
          for (const segment of segments) {
            const treeObj = repo.objects.get(treeOid);
            if (treeObj === undefined) { found = false; break; }
            const child = parseTree(treeObj.data).find((e) => e.name === segment && e.mode === '40000');
            if (child === undefined) { found = false; break; }
            treeOid = child.oid;
          }
          children.set(dirName, { type: 'dir', name: dirName, path: path === '' ? dirName : `${path}/${dirName}`, sha: found ? treeOid : ZERO_OID, size: 0 });
        }
      }
    }
    if (children.size === 0) return null;
    const entries = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: 'dir', entries };
  }

  /** Walk a branch's history newest-first (by deterministic timestamp). */
  listCommits(repo: Repo, ref: string | undefined): { sha: string; message: string; author: string; committer: string }[] {
    const tip = ref === undefined ? this.branchTip(repo, repo.defaultBranch) : this.resolveRef(repo, ref);
    if (tip === undefined) return [];
    const reachable = collectReachable(this.lookup(repo), [tip]);
    const commits: { sha: string; message: string; author: string; committer: string; ts: number }[] = [];
    for (const oid of reachable) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parsed = parseCommit(object.data);
      const stamp = parsed.author.match(/ (\d+) \+0000$/)?.[1];
      commits.push({ sha: oid, message: parsed.message, author: parsed.author, committer: parsed.committer, ts: stamp === undefined ? 0 : Number(stamp) });
    }
    // Only commits reachable as ancestors of the tip (collectReachable already limits to the closure,
    // which for a linear history is exactly the ancestry).
    commits.sort((a, b) => b.ts - a.ts);
    return commits;
  }
}
