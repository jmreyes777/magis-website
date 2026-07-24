// UAT F-G4: shared in-app replacement for window.confirm on the guest side
// (chat close, chat switch). Accessible: dialog role, labelled title, focus on
// the confirm action, Escape cancels, overlay click cancels.
import React, { useEffect, useRef } from "react";
import PropTypes from "prop-types";

const GuestConfirmDialog = ({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}) => {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    confirmRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onCancel?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-confirm-title"
        className="relative bg-white rounded-lg shadow-xl p-4 mx-4 max-w-sm w-full"
      >
        <h4 id="guest-confirm-title" className="text-sm font-semibold text-gray-800 mb-1">
          {title}
        </h4>
        {body && <p className="text-xs text-gray-600 mb-3">{body}</p>}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-800 border rounded"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-700 rounded"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

GuestConfirmDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  title: PropTypes.string.isRequired,
  body: PropTypes.string,
  confirmLabel: PropTypes.string,
  cancelLabel: PropTypes.string,
  onConfirm: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};

export default GuestConfirmDialog;
