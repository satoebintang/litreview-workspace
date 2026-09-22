import type { ReactNode } from "react";

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export type AlertTone = "info" | "success" | "warning" | "danger" | "error";

export type AlertProps = {
  children: ReactNode;
  tone?: AlertTone;
  title?: ReactNode;
  className?: string;
  role?: "alert" | "status" | "region";
};

export function Alert({ children, tone = "info", title, className, role }: AlertProps) {
  const normalizedTone = tone === "error" ? "danger" : tone;
  const resolvedRole = role ?? (normalizedTone === "danger" ? "alert" : "status");

  return (
    <div
      className={joinClassNames("alert", `alert--${normalizedTone}`, className)}
      role={resolvedRole}
      aria-live={resolvedRole === "alert" ? "assertive" : "polite"}
    >
      {title && <strong className="alert__title">{title}</strong>}
      <div className="alert__content">{children}</div>
    </div>
  );
}
