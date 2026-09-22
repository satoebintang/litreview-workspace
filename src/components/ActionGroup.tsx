import type { ReactNode } from "react";

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export type ActionGroupProps = {
  children: ReactNode;
  label?: string;
  className?: string;
};

export function ActionGroup({ children, label = "Actions", className }: ActionGroupProps) {
  return (
    <div className={joinClassNames("action-group", className)} role="group" aria-label={label}>
      {children}
    </div>
  );
}
