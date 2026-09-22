import Link from "next/link";
import type { ReactNode } from "react";

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export type BreadcrumbItem = {
  label: ReactNode;
  href?: string;
  current?: boolean;
};

export type BreadcrumbsProps = {
  items: readonly BreadcrumbItem[];
  label?: string;
  className?: string;
};

export function Breadcrumbs({ items, label = "Breadcrumbs", className }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <nav className={joinClassNames("breadcrumbs", className)} aria-label={label}>
      <ol className="breadcrumbs__list">
        {items.map((item, index) => {
          const current = item.current ?? index === items.length - 1;
          return (
            <li className="breadcrumbs__item" key={`${index}-${String(item.label)}`}>
              {current || !item.href ? (
                <span aria-current={current ? "page" : undefined}>{item.label}</span>
              ) : (
                <Link href={item.href}>{item.label}</Link>
              )}
              {index < items.length - 1 && (
                <span className="breadcrumbs__separator" aria-hidden="true">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
