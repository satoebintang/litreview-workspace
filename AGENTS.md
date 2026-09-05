# Project Agent Instructions

<!-- BEGIN SHARED-CODE-MEMORY-POLICY -->

## Shared code-memory policy

### Project identity

The canonical Graphiti group ID for this repository is:

`
repo-local-litreview-workspace
`

Always use this exact `group_id` for Graphiti reads and writes related
to this repository.

Do not use Graphiti's default `main` group for project-specific memory.

The canonical group ID is also stored in:

`
.graphiti-group-id
`

### Source of truth

Source code, tests, configuration, and observed runtime behavior are the
ground truth for the current implementation.

Git history, when available, is authoritative for version history.

Graphiti and codebase-memory-mcp supplement these sources; neither replaces
them.

### codebase-memory-mcp

Use codebase-memory-mcp primarily for the current structural state of the
repository, including:

- symbols and definitions
- callers and callees
- imports and dependencies
- code paths
- routes
- repository structure
- impact analysis
- structural code discovery

Prefer codebase-memory-mcp over broad grep/glob/file-search when its graph
can answer the structural question.

### Graphiti

Use Graphiti for durable engineering context that is not reliably
recoverable from the current source tree, including:

- architectural decisions and rationale
- important constraints
- confirmed debugging findings
- root causes of incidents or defects
- rejected approaches and why they were rejected
- migration decisions and transitional state
- non-obvious integration behavior
- durable operational knowledge likely to matter in future sessions

For this repository, always explicitly use:

`
group_id = repo-local-litreview-workspace
`

Do not store routine conversation, temporary speculation, obvious
source-code facts, or information already represented adequately by
codebase-memory-mcp.

### Preferred workflow

For non-trivial engineering work:

1. Search Graphiti in `repo-local-litreview-workspace` for relevant historical decisions,
   constraints, and prior findings.
2. Query codebase-memory-mcp for the current structural implementation.
3. Read only the necessary source files.
4. Make and test the change.
5. Persist only confirmed, durable, non-obvious findings to Graphiti.

### Memory-write discipline

A Graphiti write should generally satisfy all of these conditions:

- confirmed rather than speculative
- useful beyond the current conversation
- not obvious from reading the current source tree
- likely to affect future implementation, debugging, maintenance, or design

When those conditions are not met, do not write memory.

### Graphiti ingestion verification

- add_memory is asynchronous. Its successful response only means the episode was queued.
- Always use group_id=repo-local-litreview-workspace for both writes and reads.
- After add_memory, verify with get_episodes first, then wait and query search_memory_facts.
- No relevant facts found does not mean no episode exists. Compare episode, node, and fact results.
- If the episode exists but facts remain absent, inspect Graphiti worker/LLM logs before retrying.
- Do not manually create arbitrary Neo4j relationships; repair the ingestion worker or re-ingest after fixing it.

<!-- END SHARED-CODE-MEMORY-POLICY -->