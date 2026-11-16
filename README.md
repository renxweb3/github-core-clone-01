# github-core-clone-01

A standalone GitHub-compatible git forge: one process serving git smart HTTP,
REST v3, GraphQL and MCP from its own store. Built for the Make.fun
github-core-clone-01 bounty.

## Run

Requires Node.js 22. The entrypoint is `main.ts`:

```sh
node main.ts
```

`main.ts` binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`,
then polls `/done` until the environment finishes the run.

## Layout

Flat modules, Node.js standard library only, no git binary, no package
manager:

- `main.ts` — lifecycle (bind, register, poll, exit)
- `app.ts` — HTTP server, routing, auth
- `git.ts` — pkt-line codec, pack read/write, smart HTTP fetch/receive-pack
- `store.ts` — git object store, refs, issues, pulls, three-way merge
- `rest.ts` — REST v3 router
- `graphql.ts` — GraphQL parser + executor
- `mcp.ts` — MCP JSON-RPC tools
- `types.ts`, `util.ts` — shared types and helpers

## Local measurements

Measured with the competition kit's own `sdk/run.ts` against a freshly
started server (this VM, not the grading box):

- Conformance: 120/120 checks (feature 600/600), agent 200/200
- Perf (5 runs): 198 / 194 / 185 / 194 / 176 — median 194, worst 176

## License

MIT — see [LICENSE](LICENSE).
