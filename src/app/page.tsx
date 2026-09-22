import Link from "next/link";
import { createProjectAction } from "./actions";
import { reviewServices } from "./server";
import { PROJECT_CARD_PAGE_SIZE } from "@/application/project-workspace-read-services";

type HomeSearchParams = { error?: string; page?: string };

function requestedPage(value: string | undefined) {
  const page = Number(value ?? "1");
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function formatCreatedAt(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

export default function Home({ searchParams }: { searchParams?: Promise<HomeSearchParams> }) {
  return <HomeContent searchParams={searchParams} />;
}

async function HomeContent({ searchParams }: { searchParams?: Promise<HomeSearchParams> }) {
  const params = searchParams ? await searchParams : {};
  const projectPage = await reviewServices.listProjectCards({ page: requestedPage(params.page), pageSize: PROJECT_CARD_PAGE_SIZE });

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link>
        <span className="top-note">Evidence-first literature reviews</span>
      </header>
      <div className="container landing">
        <section className="project-discovery" aria-labelledby="projects-heading">
          <div className="page-header">
            <div className="page-header__content">
              <p className="eyebrow">Project discovery</p>
              <h1 id="projects-heading">Your projects</h1>
              <p className="page-header__description">Resume a review or start a new research workspace. Projects are ordered by creation date.</p>
            </div>
            <span className="status-badge status-badge--neutral">{projectPage.totalCount} {projectPage.totalCount === 1 ? "project" : "projects"}</span>
          </div>
          {projectPage.projects.length === 0 ? (
            <div className="empty-state">
              <h2>No projects yet</h2>
              <p>Create a project below, then define its Research Questions explicitly from the Plan workspace.</p>
            </div>
          ) : (
            <div className="project-card-grid">
              {projectPage.projects.map((project) => (
                <article className="card project-card" key={project.id}>
                  <div className="project-card__heading">
                    <div>
                      <p className="eyebrow">Created {formatCreatedAt(project.createdAt)}</p>
                      <h2><Link href={`/projects/${project.id}`}>{project.title}</Link></h2>
                    </div>
                    <span className="status-badge status-badge--neutral">{project.paperCount} {project.paperCount === 1 ? "Paper" : "Papers"}</span>
                  </div>
                  {project.description && <p className="project-card__description">{project.description}</p>}
                  <dl className="project-card__facts">
                    <div><dt>Research Questions</dt><dd>{project.researchQuestionCount}</dd></div>
                    <div><dt>First question</dt><dd>{project.firstResearchQuestion ?? "Not defined yet"}{project.researchQuestionCount > 1 && <span className="hint"> + {project.researchQuestionCount - 1} more</span>}</dd></div>
                    <div><dt>Unscreened</dt><dd>{project.unscreenedPaperCount}</dd></div>
                  </dl>
                  <Link className="button secondary project-card__action" href={`/projects/${project.id}`}>Open Overview <span aria-hidden="true">→</span></Link>
                </article>
              ))}
            </div>
          )}
          {projectPage.totalPages > 1 && (
            <nav className="pagination" aria-label="Project pages">
              {projectPage.hasPrevious ? <Link className="button ghost" href={`/?page=${projectPage.page - 1}`}>Previous</Link> : <span className="button ghost disabled" aria-disabled="true">Previous</span>}
              <span aria-current="page">Page {projectPage.page} of {projectPage.totalPages}</span>
              {projectPage.hasNext ? <Link className="button ghost" href={`/?page=${projectPage.page + 1}`}>Next</Link> : <span className="button ghost disabled" aria-disabled="true">Next</span>}
            </nav>
          )}
        </section>

        <div className="home-lower-grid">
          <section className="card form-card" aria-labelledby="create-project-heading">
            <p className="eyebrow">New workspace</p>
            <h2 id="create-project-heading">Create a new project</h2>
            <p className="form-intro">Start with a project boundary. Add canonical Research Questions explicitly when you are ready.</p>
            {params.error && <div className="error-banner" role="alert" tabIndex={-1}>{params.error}</div>}
            <form action={createProjectAction}>
              <div className="field"><label htmlFor="project-title">Project title</label><input id="project-title" name="title" required placeholder="e.g. Sleep and academic performance" /></div>
              <div className="field"><label htmlFor="project-description">Description <span className="hint">optional</span></label><textarea id="project-description" name="description" placeholder="A short note about the review's scope" /></div>
              <button className="button" type="submit">Create project <span aria-hidden="true">→</span></button>
            </form>
          </section>
          <section aria-label="Tracework principles" className="feature-list">
            <div className="feature"><span className="feature-number">01</span><div><h3>Source stays visible</h3><p>Capture the exact passage and page as you work, so evidence never becomes an orphaned note.</p></div></div>
            <div className="feature"><span className="feature-number">02</span><div><h3>Claims earn their footing</h3><p>See at a glance which claims are supported and which still need a source.</p></div></div>
            <div className="feature"><span className="feature-number">03</span><div><h3>Provenance is one click away</h3><p>Follow the chain from a claim to evidence, then back to the Paper it came from.</p></div></div>
          </section>
        </div>
      </div>
    </main>
  );
}
