"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  matchProjectRoute,
  projectPrimaryHref,
  PROJECT_PRIMARY_ROUTES,
  type ProjectPrimaryRouteKey,
} from "../route-contract";

export function ProjectNav({ projectId, mobile = false }: { projectId: string; mobile?: boolean }) {
  const pathname = usePathname() ?? "";
  const activeKey = matchProjectRoute(pathname, projectId)?.key;
  const label = mobile ? "Project menu" : "Project navigation";

  return (
    <nav aria-label={label} data-testid={mobile ? "project-mobile-nav" : "project-nav"}>
      <ul className="project-nav-list">
        {PROJECT_PRIMARY_ROUTES.map((route) => {
          const active = activeKey === route.key;
          return (
            <li key={route.key}>
              <ProjectNavLink
                projectId={projectId}
                routeKey={route.key}
                label={route.label}
                href={projectPrimaryHref(projectId, route.key)}
                active={active}
              />
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ProjectNavLink({
  routeKey,
  label,
  href,
  active,
}: {
  projectId: string;
  routeKey: ProjectPrimaryRouteKey;
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      className={`project-nav-link${active ? " active" : ""}`}
      href={href}
      data-route-key={routeKey}
      aria-current={active ? "page" : undefined}
    >
      {label}
    </Link>
  );
}
