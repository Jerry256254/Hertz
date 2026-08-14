import { useState } from "react";
import { Trash2 } from "lucide-react";

/**
 * Two-click delete: first click asks for confirmation inline (no native dialog,
 * no full modal for something this small), second click actually deletes.
 * Used anywhere something destructible needs a delete affordance — sessions,
 * projects, agents, meetings, providers.
 */
export function DeleteButton({
  onDelete,
  title = "Delete",
  size = 13,
  className = "",
}: {
  onDelete: () => void | Promise<void>;
  title?: string;
  size?: number;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  if (confirming) {
    return (
      <span className="flex flex-shrink-0 items-center gap-1.5 text-xs" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          disabled={pending}
          onClick={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            setPending(true);
            await onDelete();
          }}
          className="font-medium text-danger hover:underline disabled:opacity-50"
        >
          {pending ? "…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setConfirming(false);
          }}
          className="text-fg-subtle hover:text-fg"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setConfirming(true);
      }}
      className={`flex-shrink-0 text-fg-subtle hover:text-danger ${className}`}
    >
      <Trash2 size={size} />
    </button>
  );
}
