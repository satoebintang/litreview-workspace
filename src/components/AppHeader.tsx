import Link from "next/link";
import type { ReactNode } from "react";

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export type AppHeaderProps = {
  projectTitle?: ReactNode;
  topNote?: ReactNode;
  trailing?: ReactNode;
  className?: string;
};

export function AppHeader({
  projectTitle,
  topNote = "Evidence-first literature reviews",
  trailing,
  className,
}: AppHeaderProps) {
  return (
    <header className={joinClassNames("app-header", className)}>
      <div className="app-header__bar">
        <Link className="app-header__brand brand" href="/" aria-label="Tracework home">
          <span className="brand-mark" aria-hidden="true">
            T
          </span>
          <span>Tracework</span>
        </Link>
        {projectTitle && <div className="app-header__context">{projectTitle}</div>}
        <div className="app-header__trailing">
          {trailing ?? <span className="top-note">{topNote}</span>}
        </div>
      </div>
    </header>
  );
}
