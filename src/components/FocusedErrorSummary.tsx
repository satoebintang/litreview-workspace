"use client";

import { useEffect, useRef } from "react";

export function FocusedErrorSummary({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, [message]);
  return <div ref={ref} className="error-banner" role="alert" tabIndex={-1}>
    <p>There are problems with this form.</p>
    <p>{message}</p>
  </div>;
}
