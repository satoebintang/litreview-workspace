import type { ReactNode } from "react";

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export type PageHeaderProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  eyebrow,
  description,
  status,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header className={joinClassNames("page-header", className)}>
      <div className="page-header__content">
        {eyebrow && <p className="page-header__eyebrow eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-header__description">{description}</p>}
      </div>
      {(status || actions) && (
        <div className="page-header__aside">
          {status && <div className="page-header__status">{status}</div>}
          {actions}
        </div>
      )}
    </header>
  );
}
