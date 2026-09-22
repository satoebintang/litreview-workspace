"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { getProjectBreadcrumbs } from "../route-contract";

export function ProjectBreadcrumbs({ projectId, projectTitle }: { projectId: string; projectTitle: string }) {
  const pathname = usePathname() ?? "";
  const breadcrumbs = getProjectBreadcrumbs(projectId, pathname, projectTitle);

  if (breadcrumbs.length === 0) return null;

  return (
    <nav className="project-breadcrumbs container" aria-label="Breadcrumb" data-testid="project-breadcrumbs">
      <ol>
        {breadcrumbs.map((breadcrumb, index) => (
          <li key={`${breadcrumb.label}-${index}`}>
            {breadcrumb.current || !breadcrumb.href ? (
              <span aria-current={breadcrumb.current ? "page" : undefined}>{breadcrumb.label}</span>
            ) : (
              <Link href={breadcrumb.href}>{breadcrumb.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
