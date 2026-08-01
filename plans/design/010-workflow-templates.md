# Design spike 010: user-defined workflow templates

## Decision

**DEFER.** Do not build user-defined workflow templates now.

There is no concrete demand in the repository, its reachable history, or its
GitHub issues. A template loader would be a speculative config/plugin layer in
direct conflict with `AGENTS.md:39`. The fact that the current pipeline is
data-shaped makes a loader mechanically approachable; it does not create a
user need.

## 1. Demand evidence

The evidence search found no request for a non-default pipeline:

- `git log --all --oneline | head -60` showed workflow implementation,
  hardening, and lifecycle fixes, but no custom-pipeline request or template
  feature branch.
- `git log --all -G 'user-defined|non-default|template param|audit-only|audit only|fixed pipeline'`
  and commit-message searches found no user demand. The relevant historical
  signal points in the opposite direction: the initial workflow implementation
  at `9f92196` exposed a `template` parameter that accepted only `repo-task` or
  `default`; `1674e48` explicitly removed that unused parameter in a
  ponytail audit; `3bc0674` removed the remaining template wrapper and stored
  label in favor of fixed phases.
- `rg -n 'TODO|FIXME|deferred|for now' extensions skills` found only the already
  documented deferred interactive dashboard. No marker asks for a configurable
  workflow.
- Searches of `README.md`, `skills/`, `extensions/`, `plans/`, and `.github/`
  found no promise or abandoned design for custom workflows. `.github/`
  contains only the verification workflow and no issue templates.
- Apart from this spike's `advisor/010-spike-templates` execution branch,
  `git branch -a -vv` showed no local or remote branch for workflow templates.
- The live public GitHub issue query returned zero issues, open or closed.
- Current documentation consistently promises the fixed flow:
  `README.md:64`, `skills/workflows/SKILL.md:12`, and
  `skills/workflows/SKILL.md:43`.

Plan 007 is not demand evidence. Its committed result at
`plans/design/007-subagent-extensions.md` is a design-only result, and its
follow-up test proves existing single-extension-path forwarding. It does not
ship agent `extensions` frontmatter or request configurable workflow phases.

## 2. YAGNI verdict

User-defined templates would be both a configuration layer and a small plugin
framework: repository files would select child prompts, models, tools, and
execution order. Building that without a request violates the explicit
`AGENTS.md:39` rule against speculative abstractions, config layers, and plugin
frameworks.

There is no justified exception. **Verdict: defer.** Keep the fixed pipeline and
the documented `no template param` limit.

## 3. Observable triggers to revisit

Reopen this decision only when at least one of these can be linked to concrete
issues or usage reports:

1. Two distinct users request non-default pipelines and provide phase/task
   shapes that the current pipeline cannot express.
2. One documented workflow recurs at least three times and requires repeatedly
   bypassing or ignoring a fixed phase, even after trying direct `sa_spawn`
   composition.
3. A second package-owned fixed pipeline has shipped for a real use case and a
   third concrete variant is requested. At that point there are multiple real
   call sites to generalize from.
4. A measured workflow failure shows the fixed four-phase order itself caused
   the failure, and a different order fixes the same documented workload.

Implementation convenience, plan 007 completion, or a maintainer's hypothetical
example is not a trigger by itself.

## 4. Cheapest viable shape if triggered

Start with named references, not inline executable policy.

- Discovery locations: `~/.pi/agent/workflows/*.md` for user-owned templates and
  nearest-project `.pi/workflows/*.md` for repository-owned templates, bounded
  at the same trusted-project edge as `.pi/agents/`.
- Format: markdown with YAML frontmatter containing `name`, `description`, and
  ordered `phases`. Each phase contains a name and tasks with only `key`,
  `title`, and `agent`.
- Each task's `agent` names a definition already discovered through
  `discoverAgents()` (`extensions/subagents/agents.ts:214-237`). The agent
  definition remains the single owner of its prompt, tools, model, and thinking
  level. Do not allow templates to inline roles, arbitrary extension paths, or
  shell commands.
- Resolve all referenced agents and validate unique phase names/task keys before
  starting any child. Missing or ambiguous references fail the workflow before
  side effects; do not partially run a malformed template.
- Add one optional template-name selector to `wf_start` only when demand exists.
  Keep the built-in pipeline as the default. `/workflow` can remain the built-in
  shortcut until command-line selection is separately requested.
- Reuse Pi's existing frontmatter parser and the current agent discovery/trust
  behavior. Add no dependency and no generic registry.

Plan 007 could later let referenced agents request package-owned safe
extensions, but its current design is not a shipped capability. Template
loading must not depend on it. If 007 eventually ships, templates should still
reference named agents rather than duplicate extension/tool policy.

## 5. Security surface and trust gate

A workflow template is privilege-relevant. It chooses how many child processes
run, what trusted role prompt each receives, and—through referenced agent
definitions—which tools and model settings they inherit.

Minimum acceptable gate:

- User-level templates are user-controlled and follow the existing user-agent
  trust assumption.
- Project templates are discovered only when `ctx.isProjectTrusted()` is true,
  using the same repository-boundary and symlink-escape protections as
  `extensions/subagents/agents.ts:146-237`.
- In TUI/RPC, confirm before any child starts, following
  `extensions/subagents/index.ts:188-206`. One dialog should show the template
  path, referenced agent sources, effective tools, and number of tasks. A
  decline cancels the whole workflow.
- Non-interactive project-template execution should fail closed unless Pi
  exposes an explicit persisted approval for that template. Project trust alone
  is insufficient for silently launching several repo-defined prompts.

The initial implementation should reject a template whose effective capability
exceeds the built-in envelope: more than two unrestricted/write-capable tasks,
or write-capable tools on the reconnaissance or synthesis-equivalent phases.
A broader grant needs a separate per-run approval design and threat review; do
not hide it behind the ordinary project confirmation.

## 6. Fixed-phase assumptions that would change

The assumption is enumerable; this spike does not hit the STOP condition for an
unbounded load-bearing surface.

1. **Definition and orchestration.** `extensions/workflows/template.ts:3-83`
   defines the exact four phases and five tasks. `manager.ts:194-207` initializes
   runtime state from that constant, and `manager.ts:255-277` iterates the same
   constant rather than an entry-owned definition.
2. **Named phase semantics.** `manager.ts:411-412` grants file-search tools and
   its extension only to a phase literally named `reconnaissance`.
   `manager.ts:284-315` and `manager.ts:533-535` identify `synthesis` by name,
   require it for a successful final result, and write its body to `final.md`.
   The loop comment at `manager.ts:274` also assumes synthesis is last.
3. **Public tool and command surface.** `extensions/workflows/index.ts:136-141`
   describes the exact sequence, `StartParams` has no selector, and
   `index.ts:263-279` makes `/workflow` the fixed repo-task shortcut.
   `extensions/workflows/format.ts:15-24` hardcodes the sequence into start
   output.
4. **Handoff and result semantics.** `extensions/workflows/handoff.ts` is generic:
   it records the phase supplied by the manager and validates process status and
   non-empty output, not an allowed phase schema. The load-bearing behavior is
   in the manager's named synthesis handling. `handoff.test.ts:180-201` does,
   however, lock the exact phase/task sequence and role-specific trust text.
5. **Lifecycle and artifact tests.** `manager.test.ts` asserts the five spawn
   calls and their tool policy, four phase names/order, reconnaissance failure
   followed by implementation, `01-reconnaissance` artifact paths, and named
   synthesis success/fallback behavior. These are characterization tests for
   the fixed invariant, not generic-template tests.
6. **Documentation.** `README.md:64`, `skills/workflows/SKILL.md:3,12,18,43`,
   the `/workflow` description, and start-result text all promise the four named
   phases. They would need migration notes because adding a selector changes a
   public tool parameter.

`extensions/workflows/domain.ts`, `artifacts.ts`, status/list formatting, and
the JSON handoff shape already use generic phase names and arrays. They do not
themselves require exactly four phases.

## 7. Non-config-layer alternatives

Use existing `sa_spawn` composition first. A parent can spawn one or more named
or ad-hoc agents, wait for them, then issue a follow-up spawn with the gathered
evidence. This covers one-off audit, research-only, review-only, and parallel
analysis flows without adding discovery, parsing, schema, migration, or trust
machinery. The trade-off is that the parent owns sequencing and does not get one
workflow-level artifact tree; that is acceptable for unproven, occasional
needs.

If a concrete audit-only use case recurs and workflow artifacts are essential,
add one package-owned fixed pipeline such as `AUDIT_PHASES` (reconnaissance →
review → synthesis) and expose a narrow built-in enum. This reuses the manager
with a reviewed constant and introduces no repo-controlled files. It is cheaper
and safer than a template engine. Do not add even that second constant before a
real request; if it ships and a third distinct pipeline is later requested,
revisit generalization under the triggers above.

## Revisit record

Considered and deferred on 2026-08-01 at `1de8f9b`: no demand signal; the repo
previously removed an unused template selector; direct `sa_spawn` composition or
one additional package-owned fixed pipeline should be tried before a user-defined
configuration layer.
