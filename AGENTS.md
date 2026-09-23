# Repository Agent Instructions

## Sources of truth

Treat current source, tests, configuration, and observed runtime behavior as
current truth. Use Git history for implementation history. Memory and handoff
notes provide context only and never override current repository evidence.

Before continuing existing work, read .ai/handoff.md if present, then inspect
the active branch, Git status, diff, and relevant recent commits. Preserve
unrelated user changes. Do not reset, clean, overwrite, stash, or revert work
to simplify a task.

## Scope and workflow

Implement only the explicitly approved task or slice. Keep changes narrow and
preserve research semantics, provenance, and researcher-controlled acceptance.
Do not infer authorization for adjacent features or architecture changes.

For substantial work, identify acceptance criteria, inspect only relevant
history and structure, make the smallest coherent change, and run verification
that matches the scope and risk. Report checks that were not run; never claim
unverified gates passed.

Use codebase-memory when available for structural exploration and impact
analysis. Check the indexed project and relevant path coverage, then read source
for any partial, stale, or uncertain results. Search Graphiti only when
historical rationale could materially affect the task. Read .graphiti-group-id
and use that exact group. Store only confirmed, non-obvious durable findings
that are useful to future work.

## Checkpoints and releases

Create or refresh the local .ai/handoff.md when explicitly requested, when
substantial work remains unfinished, when switching agents, sessions, or
worktrees, or when usage limits are approaching. Keep it concise and under
about 600 words. Include the objective, acceptance criteria, branch, completed
work, important files, decisions, verification, unresolved issues, and next
actions. Do not include secrets or raw logs. Keep this temporary file
uncommitted unless project policy says otherwise. Remove it after its objective
is complete.

At a checkpoint, verify current repository state and relevant CBM coverage when
available. Search the canonical Graphiti group before making any durable
memory write. Do not store temporary progress in Graphiti.

Before a release, follow the current user-authorized release plan and verify
its exact baseline, required gates, and repository state. Do not create a
branch, commit, tag, push, publish, merge, or begin a later slice unless the
user explicitly authorizes that operation. Honor any explicit uncommitted stop
state.

## Security and data handling

Raise rigor for authentication, authorization, uploads, secrets, migrations,
data deletion, and infrastructure. Map affected boundaries and verify failure
behavior. Never expose credentials or raw database URLs in logs, tests,
handoffs, commits, or Graphiti.