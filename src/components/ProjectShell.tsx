import type { ReactNode } from "react";
import { AppHeader } from "./AppHeader";
import { Breadcrumbs, type BreadcrumbItem } from "./Breadcrumbs";
import { ProjectNav } from "./ProjectNav";

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export type ProjectShellProps = {
  projectId: string;
  projectTitle?: ReactNode;
  pathname?: string | null;
  breadcrumbs?: readonly BreadcrumbItem[];
  topNote?: ReactNode;
  headerTrailing?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function ProjectShell({
  projectId,
  projectTitle,
  pathname,
  breadcrumbs,
  topNote,
  headerTrailing,
  children,
  className,
}: ProjectShellProps) {
  return (
    <div className={joinClassNames("project-shell", className)}>
      <AppHeader projectTitle={projectTitle} topNote={topNote} trailing={headerTrailing} />
      <div className="project-shell__layout">
        <ProjectNav projectId={projectId} pathname={pathname} />
        <main className="project-shell__main">
          {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
          {children}
        </main>
      </div>
    </div>
  );
}
