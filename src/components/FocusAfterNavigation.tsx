"use client";

import { useEffect } from "react";

export function FocusAfterNavigation({ targetId }: { targetId?: string }) {
  useEffect(() => {
    if (targetId) document.getElementById(targetId)?.focus();
  }, [targetId]);

  return null;
}
