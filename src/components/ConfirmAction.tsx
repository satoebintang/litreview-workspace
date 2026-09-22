"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react";

export type ConfirmActionHandler = (formData: FormData) => void | Promise<void>;

export type ConfirmActionValue = string | number | boolean | null | undefined;

export type ConfirmActionHiddenFields = Readonly<Record<string, ConfirmActionValue>>;

export type ConfirmActionProps = {
  action: ConfirmActionHandler;
  label: string;
  title?: ReactNode;
  description?: ReactNode;
  consequence: ReactNode;
  hiddenFields?: ConfirmActionHiddenFields;
  optionalTextField?: {
    name: string;
    label: ReactNode;
    placeholder?: string;
    maxLength?: number;
  };
  confirmLabel?: string;
  cancelLabel?: string;
  triggerClassName?: string;
  dialogClassName?: string;
  disabled?: boolean;
};

function joinClassNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(" ");
}

export function ConfirmAction({
  action,
  label,
  title = "Confirm action",
  description,
  consequence,
  hiddenFields,
  optionalTextField,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  triggerClassName = "button ghost danger",
  dialogClassName,
  disabled = false,
}: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const id = useId().replace(/:/g, "");
  const titleId = `confirm-action-title-${id}`;
  const descriptionId = `confirm-action-description-${id}`;
  const consequenceId = `confirm-action-consequence-${id}`;
  const dialogId = `confirm-action-dialog-${id}`;

  const restoreFocus = useCallback(() => {
    const target = restoreFocusRef.current;
    if (!target) return;

    const focus = () => {
      if (target.isConnected) target.focus();
    };

    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focus);
    } else if (typeof queueMicrotask === "function") {
      queueMicrotask(focus);
    } else {
      focus();
    }
  }, []);

  const closeDialog = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    setOpen(false);
    restoreFocus();
  }, [restoreFocus]);

  const handleOpen = () => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current;
    setOpen(true);
  };

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    closeDialog();
  };

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
    cancelRef.current?.focus();
  }, [open]);

  const handleClose = () => {
    setOpen(false);
    restoreFocus();
  };

  const describedBy = [description !== undefined && description !== null ? descriptionId : null, consequenceId]
    .filter(Boolean)
    .join(" ");

  const dialog = open ? (
    <dialog
      ref={dialogRef}
      className={joinClassNames("confirm-action__dialog", dialogClassName)}
      id={dialogId}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onCancel={handleCancel}
      onClose={handleClose}
    >
      <form className="confirm-action__form" action={action}>
        <div className="confirm-action__body">
          <h2 id={titleId}>{title}</h2>
          {description !== undefined && description !== null && (
            <p id={descriptionId} className="confirm-action__description">
              {description}
            </p>
          )}
          <p id={consequenceId} className="confirm-action__consequence">
            {consequence}
          </p>
          {optionalTextField && (
            <label className="field confirm-action__optional-field">
              <span>{optionalTextField.label} <span className="hint">optional</span></span>
              <textarea name={optionalTextField.name} placeholder={optionalTextField.placeholder} maxLength={optionalTextField.maxLength} />
            </label>
          )}
          {hiddenFields &&
            Object.entries(hiddenFields).map(([name, value]) =>
              value === undefined ? null : <input key={name} type="hidden" name={name} value={value === null ? "" : String(value)} />,
            )}
        </div>
        <div className="confirm-action__actions action-group" role="group" aria-label="Confirmation actions">
          <button className="button ghost" type="button" onClick={closeDialog} ref={cancelRef} autoFocus>
            {cancelLabel}
          </button>
          <button className="button danger" type="submit">
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        className={triggerClassName}
        type="button"
        aria-haspopup="dialog"
        aria-controls={dialogId}
        onClick={handleOpen}
        disabled={disabled}
      >
        {label}
      </button>
      {typeof document !== "undefined" && dialog ? createPortal(dialog, document.body) : null}
    </>
  );
}
