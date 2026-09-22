"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState } from "react";
import { getActiveProjectNavKey, getProjectNavItems } from "./project-navigation";

export { PROJECT_PRIMARY_NAVIGATION, getActiveProjectNavKey, getProjectNavItems } from "./project-navigation";
export type { ProjectNavItem, ProjectNavKey } from "./project-navigation";

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export type ProjectNavProps = {
  projectId: string;
  pathname?: string | null;
  label?: string;
  className?: string;
};

export function ProjectNav({
  projectId,
  pathname,
  label = "Project navigation",
  className,
}: ProjectNavProps) {
  const routerPathname = usePathname();
  const [open, setOpen] = useState(false);
  const linksId = useId();
  const items = getProjectNavItems(projectId);
  const activeKey = getActiveProjectNavKey(pathname ?? routerPathname ?? "", items);

  return (
    <nav
      className={joinClassNames("project-nav", className)}
      aria-label={label}
      data-open={open ? "true" : "false"}
    >
      <button
        className="project-nav__toggle"
        type="button"
        aria-controls={linksId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>Project menu</span>
        <span className="project-nav__toggle-icon" aria-hidden="true">
          {open ? "×" : "☰"}
        </span>
      </button>
      <div className="project-nav__links" id={linksId}>
        {items.map((item) => {
          const active = item.key === activeKey;
          return (
            <Link
              className="project-nav__link"
              href={item.href}
              key={item.key}
              aria-current={active ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
