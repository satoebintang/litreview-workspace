import type { ReactNode } from "react";

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export type EmptyStateProps = {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function EmptyState({
  title = "Nothing here yet",
  description,
  action,
  children,
  className,
}: EmptyStateProps) {
  return (
    <section className={joinClassNames("empty-state", className)} aria-label={typeof title === "string" ? title : undefined}>
      {title && <h2>{title}</h2>}
      {description && <p>{description}</p>}
      {children}
      {action && <div className="empty-state__action">{action}</div>}
    </section>
  );
}
