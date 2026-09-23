"use client";

import { useEffect, useRef, type ReactNode } from "react";

type ValidatableControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isValidatableControl(element: Element): element is ValidatableControl {
  return element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
}

function fieldLabel(control: ValidatableControl): string {
  return control.labels?.[0]?.textContent?.trim()
    || control.getAttribute("aria-label")
    || control.name
    || "This field";
}

export function AccessibleValidation({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const forms = [...element.querySelectorAll("form")];
    for (const form of forms) form.noValidate = true;

    const onSubmit = (event: Event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !element.contains(form)) return;
      const invalid = [...form.elements].filter(isValidatableControl)
        .filter((control) => control.willValidate && !control.validity.valid);
      const prior = form.querySelector<HTMLElement>("[data-validation-summary]");
      if (invalid.length === 0) {
        prior?.remove();
        for (const control of [...form.elements].filter(isValidatableControl)) {
          control.removeAttribute("aria-invalid");
          const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && !id.startsWith(`${form.id || "draft-form"}-field-error-`));
          if (ids.length) control.setAttribute("aria-describedby", ids.join(" "));
          else control.removeAttribute("aria-describedby");
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      prior?.remove();
      const formId = form.id || `draft-form-${forms.indexOf(form) + 1}`;
      form.id ||= formId;
      const summary = document.createElement("div");
      summary.className = "error-banner error-summary";
      summary.setAttribute("data-validation-summary", "true");
      summary.setAttribute("role", "alert");
      summary.tabIndex = -1;
      const heading = document.createElement("p");
      heading.textContent = "There are problems with this form.";
      summary.append(heading);
      const list = document.createElement("ul");
      invalid.forEach((control, index) => {
        if (!control.id) control.id = `${formId}-control-${index + 1}`;
        const errorId = `${formId}-field-error-${index + 1}`;
        const message = control.validationMessage || "Check this field.";
        const label = fieldLabel(control);
        control.setAttribute("aria-invalid", "true");
        const describedBy = new Set((control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
        describedBy.add(errorId);
        control.setAttribute("aria-describedby", [...describedBy].join(" "));
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = `#${control.id}`;
        link.textContent = `${label}: ${message}`;
        item.append(link);
        const fieldError = document.createElement("span");
        fieldError.className = "sr-only";
        fieldError.id = errorId;
        fieldError.textContent = `${label}: ${message}`;
        item.append(fieldError);
        list.append(item);
      });
      summary.append(list);
      form.prepend(summary);
      summary.focus();
    };

    element.addEventListener("submit", onSubmit, true);
    return () => element.removeEventListener("submit", onSubmit, true);
  }, []);

  return <div ref={root} style={{ display: "contents" }}>{children}</div>;
}
