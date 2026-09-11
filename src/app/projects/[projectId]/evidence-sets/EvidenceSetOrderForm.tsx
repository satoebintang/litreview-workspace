"use client";

import { useState } from "react";

type Action = (formData: FormData) => void | Promise<void>;

export function EvidenceSetOrderForm({
  action,
  projectId,
  evidenceSetId,
  initialItems,
}: {
  action: Action;
  projectId: string;
  evidenceSetId: string;
  initialItems: Array<{ evidenceId: string; label: string }>;
}) {
  const [items, setItems] = useState(initialItems);

  function move(index: number, offset: -1 | 1) {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    setItems((current) => {
      const next = current.slice();
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  if (items.length === 0) return <div className="empty">This set has no active Evidence members.</div>;
  return <form action={action}>
    <input type="hidden" name="projectId" value={projectId} />
    <input type="hidden" name="evidenceSetId" value={evidenceSetId} />
    <div className="item-list">{items.map((item, index) => <div className="item item-row" key={item.evidenceId}>
      <input type="hidden" name="evidenceIds" value={item.evidenceId} />
      <div><strong>{index + 1}.</strong> {item.label}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="button ghost" type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${item.label} up`}>↑</button>
        <button className="button ghost" type="button" onClick={() => move(index, 1)} disabled={index === items.length - 1} aria-label={`Move ${item.label} down`}>↓</button>
      </div>
    </div>)}</div>
    <button className="button secondary" type="submit">Save order</button>
  </form>;
}
