"use client";

import { useEffect, useId, useState } from "react";
import { usePathname } from "next/navigation";
import { ProjectNav } from "./ProjectNav";

export function ProjectMobileMenu({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const menuId = `project-mobile-menu-${useId().replace(/:/g, "")}`;

  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="project-mobile-menu">
      <button
        className="project-mobile-menu__toggle"
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Project menu</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      <div id={menuId} hidden={!open} className="project-mobile-menu__panel">
        <ProjectNav projectId={projectId} mobile />
      </div>
    </div>
  );
}
