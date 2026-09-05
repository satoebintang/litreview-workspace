# Project Agent Instructions

<!-- BEGIN SHARED-CODE-MEMORY-POLICY -->

## Repository memory

Canonical Graphiti group:

```text
repo-local-litreview-workspace
```

Always use this exact `group_id` for project-specific Graphiti reads/writes. Never use the default `main` group.

The ID is also stored in `.graphiti-group-id`.

### Sources of truth

Priority:

1. Source code, tests, config, and observed runtime behavior
2. Git history for version history
3. codebase-memory-mcp (CBM) for current repository structure
4. Graphiti for durable historical/engineering context

Memory tools supplement the repository; they do not override it.

### CBM

Use codebase-memory-mcp for current structural questions, including:

* symbols/definitions
* callers/callees
* imports/dependencies
* code paths/routes
* repository structure
* impact analysis

Prefer CBM over broad grep/glob searches when its graph can answer the question.

### Graphiti

Use Graphiti for confirmed, durable, non-obvious context not reliably recoverable from source, such as:

* architectural decisions and rationale
* important constraints
* debugging/root-cause findings
* rejected approaches
* migration decisions
* integration quirks
* durable operational lessons

Do not store routine conversation, speculation, obvious source facts, transient progress, secrets, or information already represented well by source/CBM.

A Graphiti write should be:

* confirmed
* useful in future sessions
* non-obvious from current source
* relevant to future implementation, debugging, maintenance, or design

### Engineering workflow

For non-trivial work:

1. Search Graphiti group `repo-local-litreview-workspace` for prior decisions/constraints/findings.
2. Query CBM for the current implementation.
3. Read only necessary source files.
4. Make and test the change.
5. Store only qualifying durable findings in Graphiti.

### Graphiti write verification

`add_memory` is asynchronous; success only means the episode was queued.

After writing:

1. Use `get_episodes` to confirm the episode.
2. Wait for ingestion, then check `search_memory_facts`.
3. If the episode exists but facts do not, inspect Graphiti worker/LLM logs before retrying.
4. Do not manually create arbitrary Neo4j relationships; fix ingestion and re-ingest.

Always use `group_id=repo-local-litreview-workspace` for verification reads.

<!-- END SHARED-CODE-MEMORY-POLICY -->

## Checkpoints and handoffs

Also follow the global instructions in:

```text
C:\Users\BSSN-769X\.codex\AGENTS.md
```

Especially the **Checkpoints and handoffs**, **CBM and source discovery**, and **Graphiti** sections. Do not modify that file from this repository.

Create or refresh a checkpoint when:

* explicitly requested
* a substantial phase ends with work remaining
* switching agents, sessions, or worktrees
* usage limits are approaching
* a long session stops or needs context reset

At a checkpoint:

1. Update `.ai/handoff.md` per global rules.
2. Reindex with CBM and verify project, generation, index status, and relevant coverage. Read any reported partial/missed ranges directly.
3. Search the canonical Graphiti group before writing memory.
4. Persist only qualifying durable Graphiti knowledge.
5. Verify Graphiti ingestion as described above.

Do not checkpoint routine completed work unless a global trigger applies.

When the objective is fully complete, perform the global final verification and remove the completed temporary handoff.
