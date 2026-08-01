# Design spike 007: subagent extension loading

This is a design result, not a shipped feature. The proof-of-concept keeps the
existing single `extensionPath` plumbing and adds no agent frontmatter or
`sa_spawn` parameter.

## 1. Recursion decision

Use a static allowlist of package-owned extensions that are safe in a child.
The first allowlist should contain only `file-search` and `web-research`.
Resolve those names to this package's known entry points; never accept a path
from an agent definition.

`subagents` and `workflows` are explicitly forbidden even if they are later
added to a broader extension registry. Reject the spawn before starting a
child with:

```text
Extension "subagents" is not allowed in subagents.
```

The same rule applies to `workflows`. This makes recursion impossible through
the supported surface: a child cannot receive either extension that starts Pi
workers. It also avoids environment markers, cross-process depth accounting,
and changes at extension load time. A marker or depth counter would spread the
guard across processes and still require every spawning extension to honor it;
the allowlist closes the boundary in one resolver.

## 2. Opt-in surface

Use per-agent-definition frontmatter:

```yaml
extensions:
  - file-search
  - web-research
```

Reject an `sa_spawn` parameter because it lets model-generated tool input pick
code to load. Reject automatic inheritance because it silently changes every
existing child and can carry spawning extensions across the process boundary.

Project definitions keep the existing trust flow. An untrusted project's
`.pi/agents/*.md` files are not discovered, so their extension requests are
never resolved. In TUI/RPC, the existing project-agent confirmation must list
the requested extension names and succeed before resolution or process start.
In non-UI mode, the existing requirement that Pi has already marked the
project trusted remains the gate. No extension path may come from the project
file, trusted or not.

## 3. Schema and validation

Add this eventual field to `AgentDefinition`:

```ts
extensions?: string[];
```

The frontmatter value must be an array of strings. Trim each name, reject empty
entries and non-string/mixed values, and deduplicate while preserving order.
Names are exact, lowercase registry keys. Do not accept absolute paths,
relative paths, URLs, npm sources, or arbitrary strings as executable paths.

Resolution has three outcomes:

- `file-search` or `web-research`: map to a package-owned entry point and load
  it if the file exists.
- `subagents` or `workflows`: fail the spawn with the recursion-boundary error.
- any other name: treat as unavailable, omit it, and report a warning in the
  spawn result.

The registry should also list the tools each extension provides. Before
starting the child, filter an explicit agent tool allowlist to built-in tools
plus tools from extensions that resolved successfully. Never add a fallback
tool the definition did not request. Agent authors who want file-search
fallback should request both sets, for example `read, fd, rg, find, grep, ls`;
the file-search extension already prefers `fd`/`rg` when loaded.

## 4. Multi-extension support

Pinned `@earendil-works/pi-coding-agent` 0.83.0 accepts repeated
`--extension` flags. This command was run against the pinned package:

```sh
PI_CODING_AGENT_DIR=/private/tmp/pi-enhanced-007-agent PI_CODING_AGENT_SESSION_DIR=/private/tmp/pi-enhanced-007-sessions node /Users/vnedyalk0v/Projects/Personal/pi-enhanced/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --offline --no-session --no-approve --no-extensions --extension /Users/vnedyalk0v/Projects/Personal/pi-enhanced/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts --extension /Users/vnedyalk0v/Projects/Personal/pi-enhanced/node_modules/@earendil-works/pi-coding-agent/examples/extensions/ssh.ts --help
```

It exited 0 and printed both registered flags, `--plan` and `--ssh`, proving
that both factories loaded. The eventual build should replace
`extensionPath?: string` with `extensionPaths?: string[]` and emit one
`--extension <path>` pair per resolved path. Do not pass the package directory
as one source because that would load unrelated extensions, including the two
spawning extensions.

## 5. Degradation

Resolve each requested safe extension independently. If its package-owned file
is absent, omit that extension, remove its extension-only tools from the child
allowlist, and continue with the remaining extensions and requested built-ins.
Return the omitted names in the spawn response, for example:

```text
Started sa-1. Unavailable extensions omitted: file-search.
```

Unknown names use the same warning path. This matches `selectReconTools`:
available capability is used, unavailable capability narrows to tools that
actually exist, and the parent operation still starts. Forbidden recursive
extensions are different: they fail closed rather than degrade.

## 6. Eventual test list

1. A named agent requesting `file-search` passes its package-owned path through
   the manager and backend, and the child exposes `fd`/`rg`.
2. A named agent requesting `subagents` is rejected before the backend starter
   runs and reports the recursion-boundary error.
3. An unknown extension name is omitted, reported in the spawn result, and the
   child still starts without an arbitrary `--extension` argument.
4. An untrusted project definition requesting an extension is not discovered;
   no confirmation, resolution, or backend start occurs.
5. A trusted interactive project definition lists requested extensions in the
   existing confirmation and loads them only after approval.
6. Two safe names produce two ordered `--extension` argument pairs and both
   tools are available in a pinned-Pi smoke check.
7. A missing safe extension removes only its unavailable extension tools and
   preserves requested built-in tools and other resolved extensions.

Use injected starters for manager tests. Only a package smoke check should run
the pinned Pi CLI; unit tests must not depend on a globally installed `pi`.

## 7. Open questions

- Is the initial allowlist of `file-search` and `web-research` sufficient, or is
  another non-spawning package extension needed by a concrete agent role?
- Should omitted-extension warnings live only in spawn text, or also in typed
  result details for RPC clients?
- Should non-UI execution of an already trusted project agent retain the
  current no-confirmation behavior, or require a new explicit automation opt-in
  before this feature ships?

The answers do not affect the spike's mechanical proof-of-concept.
