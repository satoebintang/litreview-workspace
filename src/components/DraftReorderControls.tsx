type DraftAction = (formData: FormData) => void | Promise<void>;

export function DraftReorderControls({
  action,
  projectId,
  frameworkId,
  versionId,
  expectedDraftRevision,
  ids,
  index,
  kind,
  label,
  targetId,
  scope,
}: {
  action: DraftAction;
  projectId: string;
  frameworkId: string;
  versionId: string;
  expectedDraftRevision: number;
  ids: string[];
  index: number;
  kind: "section" | "item" | "response-option" | "overall-option";
  label: string;
  targetId: string;
  scope?: { name: string; value: string };
}) {
  const renderMove = (direction: "up" | "down") => {
    const nextIndex = index + (direction === "up" ? -1 : 1);
    const disabled = nextIndex < 0 || nextIndex >= ids.length;
    const orderedIds = [...ids];
    if (!disabled) [orderedIds[index], orderedIds[nextIndex]] = [orderedIds[nextIndex], orderedIds[index]];
    return <form className="reorder-form" action={action} key={direction}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="frameworkId" value={frameworkId} />
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="expectedDraftRevision" value={expectedDraftRevision} />
      <input type="hidden" name="focusTarget" value={targetId} />
      {scope && <input type="hidden" name={scope.name} value={scope.value} />}
      {orderedIds.map((id) => <input type="hidden" name="ids" value={id} key={id} />)}
      <button className="button ghost" type="submit" aria-label={`Move ${kind} “${label}” ${direction}`} disabled={disabled}>
        Move {direction}
      </button>
    </form>;
  };

  return <div className="reorder-controls" aria-label={`Reorder ${kind} ${label}`}>
    {renderMove("up")}
    {renderMove("down")}
  </div>;
}
