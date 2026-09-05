import Link from "next/link";
import { createProjectAction } from "./actions";

export default function Home({ searchParams }: { searchParams?: Promise<{ error?: string }> }) {
  return <HomeContent searchParams={searchParams} />;
}

async function HomeContent({ searchParams }: { searchParams?: Promise<{ error?: string }> }) {
  const params = searchParams ? await searchParams : {};
  return (
    <main className="shell">
      <header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
      <div className="container landing">
        <div className="hero">
          <p className="eyebrow">A calmer way to review literature</p>
          <h1>Keep every claim close to its source.</h1>
          <p className="lede">Tracework gives your literature review a clear working spine: collect source passages, turn them into evidence, and build claims you can audit in a click.</p>
        </div>
        <div className="hero-grid">
          <section className="card form-card" aria-labelledby="create-project-heading">
            <h2 id="create-project-heading">Start a review project</h2>
            <p className="form-intro">Begin with the question your review is trying to answer.</p>
            {params.error && <div className="error-banner" role="alert">{params.error}</div>}
            <form action={createProjectAction}>
              <div className="field"><label htmlFor="project-title">Project title</label><input id="project-title" name="title" required placeholder="e.g. Sleep and academic performance" /></div>
              <div className="field"><label htmlFor="research-question">Research question <span className="hint">optional</span></label><textarea id="research-question" name="researchQuestion" placeholder="What does the literature tell us?" /></div>
              <div className="field"><label htmlFor="project-description">Description <span className="hint">optional</span></label><textarea id="project-description" name="description" placeholder="A short note about the review's scope" /></div>
              <button className="button" type="submit">Create project <span aria-hidden="true">→</span></button>
            </form>
          </section>
          <section aria-label="Tracework principles" className="feature-list">
            <div className="feature"><span className="feature-number">01</span><div><h3>Source stays visible</h3><p>Capture the exact passage and page as you work, so evidence never becomes an orphaned note.</p></div></div>
            <div className="feature"><span className="feature-number">02</span><div><h3>Claims earn their footing</h3><p>See at a glance which claims are supported and which still need a source.</p></div></div>
            <div className="feature"><span className="feature-number">03</span><div><h3>Provenance is one click away</h3><p>Follow the chain from a claim to evidence, then back to the paper it came from.</p></div></div>
          </section>
        </div>
      </div>
    </main>
  );
}
