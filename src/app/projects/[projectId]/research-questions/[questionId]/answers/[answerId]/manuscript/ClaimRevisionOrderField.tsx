"use client";

import { useState } from "react";
import type { AnswerClaimManuscriptContext } from "@/domain/types";

function blockReason(reason: AnswerClaimManuscriptContext["selectionBlockReason"]): string {
  switch (reason) {
    case "superseded_context":
      return "Disabled: this Answer captured a superseded ClaimRevision.";
    case "withdrawn_claim":
      return "Disabled: the current ClaimRevision is withdrawn.";
    case "unsupported_claim":
      return "Disabled: the exact current ClaimRevision has no formal support.";
    case "already_in_target_section":
      return "Disabled: this exact ClaimRevision is already active in the target Section.";
    default:
      return "";
  }
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function locationLabel(location: AnswerClaimManuscriptContext["exactActivePlacements"][number], removed = false): string {
  return `${location.manuscriptTitle} / ${location.sectionTitle} · ClaimRevision sequence ${location.claimRevisionSequence}${removed ? " · removed" : ""}`;
}

function placementLocations(context: AnswerClaimManuscriptContext) {
  const locations = [
    ...context.exactActivePlacements.map((location) => ({ location, label: "Active exact placement" })),
    ...context.newerActivePlacements.map((location) => ({ location, label: "Active newer placement" })),
    ...context.olderActivePlacements.map((location) => ({ location, label: "Active older placement" })),
    ...context.historicalPlacements.map((location) => ({ location, label: "Historical removed placement" })),
  ];
  if (locations.length === 0) return <span className="hint">No placement locations.</span>;
  return (
    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
      {locations.map(({ location, label }) => (
        <li key={`${label}-${location.placementId}`}>
          {label}: {locationLabel(location, location.removedAt !== null)}
        </li>
      ))}
    </ul>
  );
}

export default function ClaimRevisionOrderField({ contexts }: { contexts: AnswerClaimManuscriptContext[] }) {
  const selectableIds = contexts.filter((context) => context.selectable).map((context) => context.claimRevisionId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  function toggle(id: string, checked: boolean) {
    setSelectedIds((current) => checked ? [...current, id] : current.filter((value) => value !== id));
  }

  function move(id: string, delta: -1 | 1) {
    setSelectedIds((current) => {
      const index = current.indexOf(id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <div data-testid="answer-claim-revisions" style={{ display: "grid", gap: 12 }}>
      <p className="hint" style={{ margin: 0 }}>
        Select eligible ClaimRevisions, then use the arrows to control the order inserted after the prose block.
      </p>
      {contexts.length === 0 ? (
        <div className="empty">This Answer has no ClaimRevision contexts.</div>
      ) : (
        <div className="item-list">
          {contexts.map((context) => {
            const selectedIndex = selectedIds.indexOf(context.claimRevisionId);
            const disabledReason = blockReason(context.selectionBlockReason);
            return (
              <article className="item" key={context.claimRevisionId} data-claim-revision-id={context.claimRevisionId}>
                <div className="item-row" style={{ alignItems: "flex-start" }}>
                  <label style={{ display: "flex", gap: 10, alignItems: "flex-start", flex: 1 }}>
                    <input
                      type="checkbox"
                      aria-label={`Select ClaimRevision ${context.claimRevisionSequence}`}
                      checked={selectedIndex >= 0}
                      disabled={!context.selectable}
                      onChange={(event) => toggle(context.claimRevisionId, event.currentTarget.checked)}
                      style={{ marginTop: 4 }}
                    />
                    <span>
                      <span className="item-title">{context.claimText || "Claim text unavailable."}</span>
                      <span className="item-meta" style={{ display: "block" }}>ClaimRevision <code>{shortId(context.claimRevisionId)}</code> · sequence {context.claimRevisionSequence}</span>
                      <span className="item-meta" style={{ display: "block" }}>
                        Exact state: {context.claimRevisionState} · current revision: {context.isCurrentRevision ? "same exact revision" : `sequence ${context.currentRevisionSequence ?? "unknown"}`} · current Claim state: {context.currentClaimState ?? "unknown"}
                      </span>
                      <span className="item-meta" style={{ display: "block" }}>
                        Formal support: {context.supportCount} {context.supportCount === 1 ? "edge" : "edges"} · citation candidates: {context.citationCandidateCount}
                      </span>
                      <span className="item-meta" style={{ display: "block" }}>
                        Selection: {context.selectable ? "eligible" : `blocked · ${disabledReason}`}
                      </span>
                      {disabledReason && <span className="support-warning" style={{ display: "block", marginTop: 6 }}>{disabledReason}</span>}
                      <div className="item-meta" style={{ marginTop: 6 }}>
                        <strong>Placement locations</strong>
                        {placementLocations(context)}
                      </div>
                    </span>
                  </label>
                  {selectedIndex >= 0 && (
                    <div className="claim-list-actions" aria-label={`Order controls for ClaimRevision ${context.claimRevisionSequence}`}>
                      <span className="status supported">#{selectedIndex + 1}</span>
                      <button type="button" className="button ghost" onClick={() => move(context.claimRevisionId, -1)} disabled={selectedIndex === 0} aria-label="Move ClaimRevision earlier">↑</button>
                      <button type="button" className="button ghost" onClick={() => move(context.claimRevisionId, 1)} disabled={selectedIndex === selectedIds.length - 1} aria-label="Move ClaimRevision later">↓</button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {selectedIds.map((id) => <input key={id} type="hidden" name="claimRevisionIds" value={id} />)}
      {selectableIds.length > 0 && selectedIds.length === 0 && <p className="hint" data-testid="claim-order-empty" style={{ margin: 0 }}>No ClaimRevisions selected. Prose-only drafting is allowed.</p>}
    </div>
  );
}
