import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Focus-trapping modal behavior shared by Dialog/Sheet (spec section 4):
 * traps Tab within the panel, closes on Escape when dismissible, restores
 * focus to the trigger on close, and locks body scroll while open.
 */
export function useModal(
  open: boolean,
  onClose: () => void,
  dismissible: boolean,
  initialFocus: "first" | "last" = "first",
) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const panel = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const list = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];

    const items = list();
    const initial = initialFocus === "last"
      ? items[items.length - 1]
      : items[0];
    (initial ?? panel)?.focus();

    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusables = list();
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = bodyOverflow;
      previous?.focus?.();
    };
  }, [open, onClose, dismissible, initialFocus]);

  return ref;
}
