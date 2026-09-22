import type { ReactNode } from "react";

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export type AuditDetailItem = {
  label: ReactNode;
  value: ReactNode;
};

export type AuditDetailsProps = {
  items?: readonly AuditDetailItem[];
  title?: ReactNode;
  defaultOpen?: boolean;
  children?: ReactNode;
  className?: string;
};

export function AuditDetails({
  items = [],
  title = "Audit details",
  defaultOpen = false,
  children,
  className,
}: AuditDetailsProps) {
  return (
    <details className={joinClassNames("audit-details", className)} open={defaultOpen || undefined}>
      <summary>{title}</summary>
      {items.length > 0 && (
        <dl className="audit-details__list">
          {items.map((item, index) => (
            <div className="audit-details__item" key={`${index}-${String(item.label)}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </details>
  );
}
