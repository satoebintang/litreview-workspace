import type { ReactNode } from "react";

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

export type StatusBadgeProps = {
  children: ReactNode;
  tone?: StatusTone;
  className?: string;
  role?: "status" | "note";
};

export function StatusBadge({
  children,
  tone = "neutral",
  className,
  role = "status",
}: StatusBadgeProps) {
  return (
    <span className={joinClassNames("status-badge", `status-badge--${tone}`, className)} role={role}>
      {children}
    </span>
  );
}
