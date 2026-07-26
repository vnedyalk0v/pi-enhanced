# Plan 015: Disambiguate ask_user choices

> **Executor instructions**: Make every displayed choice uniquely reversible to
> its original option without changing the tool's public answer shape. Test
> through the registered tool with a minimal fake UI. Update the index when
> done.
>
> **Drift check (run first)**:
> `git diff --stat 9035686..HEAD -- extensions/ask-user/index.ts extensions/ask-user/index.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 013
- **Category**: bug
- **Planned at**: commit `9035686`, 2026-07-26

## Why this matters

The UI returns the selected display string. Production maps that string back
with `labels.indexOf()`, so duplicate labels select the first option and a real
option named `Other (type answer)` is mistaken for the free-text sentinel.
Numbered display labels make the mapping deterministic without changing the
tool schema or returned answers.

## Current state

`extensions/ask-user/index.ts:28` defines:

```ts
const OTHER = "Other (type answer)";
```

Lines 55-59 render option labels without unique identifiers and append the same
sentinel. Lines 79-84 use `labels.indexOf(selected)` to recover the option.

There are no tests for this extension.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Target tests | `node --test --experimental-strip-types extensions/ask-user/index.test.ts` | all pass |
| Gates | `npm run verify` | exit 0 |

## Scope

**In scope**:

- `extensions/ask-user/index.ts`
- `extensions/ask-user/index.test.ts` (new)

**Out of scope**:

- Changing the tool schema or answer detail shape.
- Adding validation beyond the current TypeBox schema.
- A reusable menu abstraction.
- Redesigning sequential question flow.

## Git workflow

- Branch: `advisor/015-disambiguate-ask-user-choices`
- Commit: `fix(ask-user): disambiguate choice labels`

## Steps

### Step 1: Add behavior tests through the tool

Use a minimal fake `ExtensionAPI` that captures the `ask_user` registration and
a fake UI that records `select` options. Cover:

- two options with identical labels return the specifically selected second
  option;
- duplicate label plus duplicate description remains distinguishable;
- a real option labeled `Other (type answer)` remains a normal option;
- the generated free-text choice opens `input` and returns `wasCustom: true`;
- cancellation behavior and the existing answer shape remain unchanged.

Do not export a production helper solely for testing if the registered tool can
be exercised directly. Use real structural test types; do not use `as any`.

**Verify before the fix**:
`node --test --experimental-strip-types extensions/ask-user/index.test.ts`
→ duplicate/sentinel cases fail.

### Step 2: Number displayed choices

Render each option with a stable one-based prefix, for example:

```text
1. Label — description
2. Label — description
3. Other (type answer)
```

Keep an array that pairs each unique display string with its original option
index or marks it as the custom choice. Resolve the returned UI string through
that array, not through the unqualified label list.

The answer must remain the original option's `label`, not the numbered display
text. Use the same numbering for the custom row so a user-supplied label cannot
collide with it.

**Verify**:

- All target tests pass.
- Existing normal choices display and return the same semantic answers.
- Multiple-question titles still include the question ID.

### Step 3: Run full gates

**Verify**:

- `npm run check` → exit 0.
- `npm test` → all tests pass.
- `npm run smoke:package` → exit 0.
- `git diff --check` → clean.

## Test plan

One registered-tool test file covers duplicate display text, sentinel
collision, custom input, cancellation, and unchanged result details. No real
TUI session is required.

## Done criteria

- [ ] Every displayed row is unique within a question.
- [ ] Selection maps to the exact original option.
- [ ] A real option cannot collide with the free-text row.
- [ ] Public parameters and answer details are unchanged.
- [ ] Full verification passes.

## STOP conditions

- Pi's select API returns an identifier other than the displayed string in the
  pinned version; use that native identifier instead.
- Unique numbering materially breaks an established accessibility or snapshot
  contract.
- Testing requires a real interactive Pi session.

## Maintenance notes

Keep the mapping local. A shared choice model is unwarranted until another tool
has the same reversible-label requirement.
