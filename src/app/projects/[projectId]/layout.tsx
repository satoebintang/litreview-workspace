import { notFound } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { getProjectForRoute } from "./project-read";
import { AppHeader } from "./AppHeader";
import { ProjectBreadcrumbs } from "./ProjectBreadcrumbs";
import { ProjectMobileMenu } from "./ProjectMobileMenu";
import { ProjectNav } from "./ProjectNav";

export default async function ProjectLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}>) {
  const { projectId } = await params;
  let project;
  try {
    project = await getProjectForRoute(projectId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }

  return (
    <div className="project-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <AppHeader projectId={projectId} projectTitle={project.title} />
      <div className="project-frame">
        <aside className="project-sidebar" aria-label="Project navigation">
          <ProjectNav projectId={projectId} />
        </aside>
        <div className="project-body">
          <ProjectMobileMenu projectId={projectId} />
          <ProjectBreadcrumbs projectId={projectId} projectTitle={project.title} />
          <main id="main-content" className="project-main">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
