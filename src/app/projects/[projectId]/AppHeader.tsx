import Link from "next/link";
import { projectPrimaryHref } from "../route-contract";

export function AppHeader({ projectId, projectTitle }: { projectId: string; projectTitle: string }) {
  return (
    <header className="topbar app-header" data-testid="app-header">
      <Link className="brand" href="/">
        <span className="brand-mark">T</span> Tracework
      </Link>
      <Link className="project-identity" href={projectPrimaryHref(projectId, "overview")} data-testid="project-identity">
        <span className="project-identity-label">Project</span>
        <strong>{projectTitle}</strong>
      </Link>
      <span className="top-note">Evidence-first literature reviews</span>
    </header>
  );
}
