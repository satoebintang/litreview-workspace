"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AppraisalWorksheetActionState } from "@/app/appraisal-form-state";

type WorksheetAction = (state: AppraisalWorksheetActionState, formData: FormData) => Promise<AppraisalWorksheetActionState>;

export function AppraisalWorksheetForm({ action, children }: { action: WorksheetAction; children: ReactNode }) {
  const initialState: AppraisalWorksheetActionState = { fieldErrors: [], formError: null };
  const [state, formAction, pending] = useActionState(action, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const fieldErrors = state.fieldErrors.filter((error) => !dismissed.has(error.controlName));
  const hasErrors = Boolean(state.formError || fieldErrors.length);

  useEffect(() => {
    const form = formRef.current;
    if (!form || !state.submittedValues) return;
    for (const [name, values] of Object.entries(state.submittedValues)) {
      const matching = [...form.elements].filter((control) => "name" in control && control.name === name) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
      matching.forEach((control, index) => {
        if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
          control.checked = values.includes(control.value);
        } else if (control instanceof HTMLSelectElement && control.multiple) {
          for (const option of [...control.options]) option.selected = values.includes(option.value);
        } else if (matching.length > 1) {
          control.value = values[index] ?? "";
        } else {
          control.value = values[0] ?? "";
        }
      });
    }
    for (const error of state.fieldErrors) {
      const field = document.getElementById(error.fieldId);
      field?.setAttribute("aria-invalid", "true");
      const controls = [...form.elements].filter((control) => "name" in control && control.name === error.controlName) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
      for (const control of controls) {
        control.setAttribute("aria-invalid", "true");
        const described = new Set((control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
        described.add(`field-error-${error.fieldId}`);
        control.setAttribute("aria-describedby", [...described].join(" "));
      }
    }
    setDismissed(new Set());
    requestAnimationFrame(() => summaryRef.current?.focus());
  }, [state]);

  function handleInput(event: FormEvent<HTMLFormElement>) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
    const name = target.name;
    if (!name) return;
    target.removeAttribute("aria-invalid");
    const error = state.fieldErrors.find((entry) => entry.controlName === name);
    if (error) {
      document.getElementById(error.fieldId)?.removeAttribute("aria-invalid");
      const errorId = `field-error-${error.fieldId}`;
      const controls = [...(formRef.current?.elements ?? [])].filter((control) => "name" in control && control.name === name) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
      for (const control of controls) {
        control.removeAttribute("aria-invalid");
        const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== errorId);
        if (ids.length) control.setAttribute("aria-describedby", ids.join(" "));
        else control.removeAttribute("aria-describedby");
      }
      setDismissed((current) => new Set(current).add(name));
    }
  }

  return <form ref={formRef} action={formAction} onInput={handleInput} noValidate>
    {hasErrors && <div ref={summaryRef} className="error-banner error-summary" role="alert" tabIndex={-1}>
      <p>There are problems with this form.</p>
      {state.formError && <p>{state.formError}</p>}
      {fieldErrors.length > 0 && <ul>{fieldErrors.map((error) => <li key={error.controlName}>
        <a href={`#${error.fieldId}`}>{error.message}</a>
        <span className="sr-only" id={`field-error-${error.fieldId}`}>{error.message}</span>
      </li>)}</ul>}
    </div>}
    {children}
    <div className="sr-only" aria-live="polite">{pending ? "Saving appraisal revision." : ""}</div>
  </form>;
}
