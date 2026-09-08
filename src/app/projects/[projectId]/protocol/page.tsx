import Link from "next/link";
import { notFound } from "next/navigation";
import {
  createResearchQuestionAction,
  createRetrievedRecordAction,
  createSearchRunAction,
  createSearchSourceAction,
  createSearchStrategyAction,
} from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

type Question = { id: string; identifier: string; label: string; sortOrder: number; archivedAt: Date | null };
type Criterion = { id: string; type: string; text: string; archivedAt: Date | null };
type Source = { id: string; sourceKey: string; displayName: string; archivedAt: Date | null };
type Strategy = { id: string; searchSourceId: string; name: string; queryText: string; filtersText: string | null; notes: string | null; archivedAt: Date | null };
type Run = { id: string; sequence: number; searchSourceId: string; sourceKeySnapshot: string; sourceDisplayNameSnapshot: string; queryText: string; filtersTextSnapshot: string | null; reportedResultCount: number; executedAt: Date; notes: string | null };

function dateInput(value: Date) {
  return value.toISOString().slice(0, 16);
}

export default async function ProtocolPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const [questions, criteria, sources, strategies, runs] = await Promise.all([
    reviewServices.listResearchQuestions(projectId),
    reviewServices.listScreeningCriteria(projectId, true),
    reviewServices.listSearchSources(projectId),
    reviewServices.listSearchStrategies(projectId),
    reviewServices.listSearchRuns(projectId),
  ]) as unknown as [Question[], Criterion[], Source[], Strategy[], Run[]];
  const activeCriteria = criteria.filter((criterion) => !criterion.archivedAt);
  const activeSources = sources.filter((source) => !source.archivedAt);
  const activeStrategies = strategies.filter((strategy) => !strategy.archivedAt);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const defaultStrategy = activeStrategies[0];
  const defaultSource = defaultStrategy ? sourceById.get(defaultStrategy.searchSourceId) : activeSources[0];

  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}`}>← Back to workspace</Link>
      <div className="workspace-header"><div><p className="eyebrow">Review protocol</p><h1>Protocol &amp; search</h1><p>{project.title} · preserve the exact history of every search.</p></div><Link className="button secondary" href={`/projects/${projectId}/screening`}>Open screening criteria →</Link></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">Protocol updated.</div>}

       <div className="workspace-grid">
         <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><Link className="button ghost" href={`/projects/${projectId}/deduplication`}>Deduplication queue →</Link><Link className="button ghost" href={`/projects/${projectId}/review-flow`}>Review flow →</Link></div>
        <section className="card section-card"><div className="section-heading"><h2>Research questions</h2><span className="count">{questions.length} ordered</span></div>
          <p className="hint">Use stable identifiers such as RQ1 and RQ2. Order is part of the protocol.</p>
          <form action={createResearchQuestionAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="research-question-identifier">Identifier</label><input id="research-question-identifier" name="identifier" required placeholder="RQ2" /></div><div className="field"><label htmlFor="research-question-label">Question</label><textarea id="research-question-label" name="label" required placeholder="What does this review ask?" /></div><button className="button" type="submit">Add research question</button></form>
          <div className="item-list" style={{ marginTop: 22 }}>{questions.length === 0 ? <div className="empty">No research questions recorded yet.</div> : questions.map((question, index) => <article className="item" key={question.id}><div className="item-row"><strong>{index + 1}. {question.identifier}</strong><span className="count">order {question.sortOrder + 1}</span></div><div className="item-title">{question.label}</div></article>)}</div>
        </section>

        <section className="card section-card"><div className="section-heading"><h2>Screening criteria</h2><span className="count">{activeCriteria.length} active</span></div>
          <p className="hint">Existing project criteria are reused by title/abstract screening; this view keeps the protocol visible beside search work.</p>
          {activeCriteria.length === 0 ? <div className="empty">No screening criteria yet. Add them in the screening workspace.</div> : <div className="item-list">{activeCriteria.map((criterion) => <article className="item" key={criterion.id}><div className="item-meta">{criterion.type}</div><div className="item-title">{criterion.text}</div></article>)}</div>}
          <Link className="button ghost" style={{ marginTop: 14 }} href={`/projects/${projectId}/screening`}>Manage criteria</Link>
        </section>

        <section className="card section-card"><div className="section-heading"><h2>Project-local sources</h2><span className="count">{activeSources.length} active</span></div>
          <p className="hint">Built-in sources are provisioned with the project. Add a custom source when the protocol needs one.</p>
          <div className="chip-list">{activeSources.map((source) => <span className="status supported" key={source.id}>{source.displayName} <small>({source.sourceKey})</small></span>)}</div>
          <form action={createSearchSourceAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="search-source-key">Source key</label><input id="search-source-key" name="sourceKey" required placeholder="institutional_index" /></div><div className="field"><label htmlFor="search-source-name">Display name</label><input id="search-source-name" name="displayName" required placeholder="Institutional index" /></div><div className="field"><label htmlFor="search-source-url">Base URL <span className="hint">optional</span></label><input id="search-source-url" name="baseUrl" type="url" placeholder="https://example.org" /></div><div className="field"><label htmlFor="search-source-notes">Notes <span className="hint">optional</span></label><textarea id="search-source-notes" name="notes" /></div><button className="button secondary" type="submit">Add custom source</button></form>
        </section>

        <section className="card section-card"><div className="section-heading"><h2>Search strategies</h2><span className="count">{activeStrategies.length} active</span></div>
          <p className="hint">Store the exact query, optional filters, and researcher notes before recording a run.</p>
          <form action={createSearchStrategyAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="strategy-source">Source</label><select id="strategy-source" name="searchSourceId" required defaultValue={defaultSource?.id ?? ""}>{activeSources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}</select></div><div className="field"><label htmlFor="strategy-name">Strategy name</label><input id="strategy-name" name="name" required placeholder="Core database query" /></div><div className="field"><label htmlFor="strategy-query">Exact query</label><textarea id="strategy-query" name="queryText" required placeholder={'("climate adaptation" AND urban)'} /></div><div className="field"><label htmlFor="strategy-filters">Optional filters</label><textarea id="strategy-filters" name="filtersText" placeholder="Years 2015–2025; peer reviewed" /></div><div className="field"><label htmlFor="strategy-notes">Notes</label><textarea id="strategy-notes" name="notes" placeholder="Why this strategy is included" /></div><button className="button" type="submit" disabled={activeSources.length === 0}>Save strategy</button></form>
          {activeStrategies.length > 0 && <div className="item-list" style={{ marginTop: 22 }}>{activeStrategies.map((strategy) => <article className="item" key={strategy.id}><div className="item-row"><div className="item-title">{strategy.name}</div><span className="status supported">{sourceById.get(strategy.searchSourceId)?.displayName ?? "Source"}</span></div><div className="quote">{strategy.queryText}</div>{strategy.filtersText && <div className="item-meta">Filters: {strategy.filtersText}</div>}</article>)}</div>}
        </section>

        <section className="card section-card full"><div className="section-heading"><h2>Record a search run</h2><span className="count">{runs.length} immutable {runs.length === 1 ? "run" : "runs"}</span></div>
          <p className="hint">A run records source identity snapshots and the exact executed query. It can be corrected only by recording another run.</p>
          <form action={createSearchRunAction} className="extraction-form"><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="run-source">Source</label><select id="run-source" name="searchSourceId" required defaultValue={defaultSource?.id ?? ""}>{activeSources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}</select></div><div className="field"><label htmlFor="run-strategy">Strategy</label><select id="run-strategy" name="strategyId" required defaultValue={defaultStrategy?.id ?? ""}>{activeStrategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name}</option>)}</select></div><div className="field"><label htmlFor="run-source-key">Source key snapshot</label><input id="run-source-key" name="sourceKeySnapshot" required defaultValue={defaultSource?.sourceKey ?? ""} placeholder="scopus" /></div><div className="field"><label htmlFor="run-source-name">Source name snapshot</label><input id="run-source-name" name="sourceDisplayNameSnapshot" required defaultValue={defaultSource?.displayName ?? ""} placeholder="Scopus" /></div><div className="field"><label htmlFor="run-query">Executed query</label><textarea id="run-query" name="queryText" required defaultValue={defaultStrategy?.queryText ?? ""} /></div><div className="field"><label htmlFor="run-filters">Filters snapshot</label><textarea id="run-filters" name="filtersTextSnapshot" defaultValue={defaultStrategy?.filtersText ?? ""} /></div><div className="field"><label htmlFor="run-count">Reported result count</label><input id="run-count" name="reportedResultCount" required type="number" min="0" defaultValue="0" /></div><div className="field"><label htmlFor="run-executed-at">Executed at</label><input id="run-executed-at" name="executedAt" required type="datetime-local" defaultValue={dateInput(new Date())} /></div><div className="field"><label htmlFor="run-notes">Run notes</label><textarea id="run-notes" name="notes" placeholder="Coverage, export details, or deviations" /></div><button className="button" type="submit" disabled={activeSources.length === 0 || activeStrategies.length === 0}>Record immutable run</button></form>
          <div className="item-list" style={{ marginTop: 22 }}>{runs.length === 0 ? <div className="empty">No runs recorded yet.</div> : runs.map((run) => <Link className="item" key={run.id} href={`/projects/${projectId}/protocol/runs/${run.id}`}><div className="item-row"><div className="item-title">Run {run.sequence} · {run.sourceDisplayNameSnapshot}</div><span className="status supported">{run.reportedResultCount} results</span></div><div className="item-meta">{run.executedAt.toLocaleString()} · exact query recorded</div><div className="quote">{run.queryText}</div></Link>)}</div>
        </section>

        <section className="card section-card full"><div className="section-heading"><h2>Manual retrieved record</h2><span className="count">Attach a result to a recorded run</span></div>
          {runs.length === 0 ? <div className="empty">Record a search run before adding retrieved records.</div> : <form action={createRetrievedRecordAction} className="extraction-form"><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="record-run">Search run</label><select id="record-run" name="searchRunId" required defaultValue={runs[0].id}>{runs.map((run) => <option key={run.id} value={run.id}>Run {run.sequence} · {run.sourceDisplayNameSnapshot}</option>)}</select></div><div className="field"><label htmlFor="record-source">Source</label><select id="record-source" name="searchSourceId" required defaultValue={runs[0].searchSourceId}>{activeSources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}</select></div><div className="field"><label htmlFor="record-source-id">Source record ID <span className="hint">optional</span></label><input id="record-source-id" name="sourceRecordId" placeholder="database result identifier" /></div><div className="field"><label htmlFor="record-title">Title</label><input id="record-title" name="title" required placeholder="Retrieved paper title" /></div><div className="field"><label htmlFor="record-authors">Authors</label><input id="record-authors" name="authors" placeholder="First Author, Second Author" /></div><div className="field"><label htmlFor="record-year">Publication year</label><input id="record-year" name="publicationYear" type="number" min="1000" max="3000" placeholder="2024" /></div><div className="field"><label htmlFor="record-venue">Venue</label><input id="record-venue" name="venue" placeholder="Journal or conference" /></div><div className="field"><label htmlFor="record-doi">DOI</label><input id="record-doi" name="doi" placeholder="10.1234/example" /></div><div className="field"><label htmlFor="record-url">URL</label><input id="record-url" name="url" type="url" placeholder="https://doi.org/..." /></div><div className="field"><label htmlFor="record-abstract">Abstract</label><textarea id="record-abstract" name="abstract" /></div><div className="field"><label htmlFor="record-raw-citation">Raw citation</label><textarea id="record-raw-citation" name="rawCitation" placeholder="Preserve the source citation exactly as retrieved" /></div><div className="field"><label htmlFor="record-retrieved-at">Retrieved at</label><input id="record-retrieved-at" name="retrievedAt" required type="datetime-local" defaultValue={dateInput(new Date())} /></div><button className="button" type="submit">Add retrieved record</button></form>}
        </section>
      </div>
      <p className="footer-note">Search runs and match history are append-only. Source snapshots remain readable even if a project-local source is later renamed.</p>
    </div></main>;
}
