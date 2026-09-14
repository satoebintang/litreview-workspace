import type {
  ManuscriptReviewEvent,
  ManuscriptReviewEventType,
  ManuscriptReviewLifecycle,
} from "./types";

export interface ManuscriptReviewReducerState {
  lifecycle: ManuscriptReviewLifecycle;
  opened: boolean;
}

/**
 * Reduce the immutable event stream to its current lifecycle. Comments are
 * intentionally lifecycle-neutral. The database repeats this transition
 * check so direct SQL cannot create a state the domain cannot represent.
 */
export function reduceManuscriptReviewEvents(events: readonly ManuscriptReviewEvent[]): ManuscriptReviewReducerState {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  let state: ManuscriptReviewReducerState = { lifecycle: "open", opened: false };
  for (const event of ordered) {
    state = applyManuscriptReviewEvent(state, event.eventType);
  }
  return state;
}

export function applyManuscriptReviewEvent(
  state: ManuscriptReviewReducerState,
  eventType: ManuscriptReviewEventType,
): ManuscriptReviewReducerState {
  if (eventType === "opened") {
    if (state.opened) throw new Error("A review thread can only be opened once");
    return { lifecycle: "open", opened: true };
  }
  if (!state.opened) throw new Error("A review thread must be opened before other events");
  if (eventType === "commented") return state;
  if (eventType === "resolved") {
    if (state.lifecycle !== "open") throw new Error("Only an open review thread can be resolved");
    return { ...state, lifecycle: "resolved" };
  }
  if (state.lifecycle !== "resolved") throw new Error("Only a resolved review thread can be reopened");
  return { ...state, lifecycle: "open" };
}

export function validateManuscriptReviewEventStream(events: readonly ManuscriptReviewEvent[]): ManuscriptReviewReducerState {
  if (events.length === 0) throw new Error("A review thread requires an opened event");
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  if (ordered[0].eventType !== "opened") throw new Error("The lowest-sequence review event must be opened");
  const openedCount = ordered.filter((event) => event.eventType === "opened").length;
  if (openedCount !== 1) throw new Error("A review thread requires exactly one opened event");
  return reduceManuscriptReviewEvents(ordered);
}
