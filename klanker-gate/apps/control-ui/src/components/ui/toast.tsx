import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { cn } from "../../lib/utils";

export type ToastTone = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
}

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  action?: ToastAction;
}

export interface ToastApi {
  success: (message: string, options?: ToastOptions) => void;
  error: (message: string, options?: ToastOptions) => void;
  info: (message: string, options?: ToastOptions) => void;
}

const NOOP: ToastApi = {
  success: () => {},
  error: () => {},
  info: () => {},
};

const ToastContext = createContext<ToastApi>(NOOP);

/** Safe outside a provider (views render standalone in unit tests). */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const TONE_ICON = {
  success: CheckCircle2,
  error: CircleAlert,
  info: Info,
} as const;

const TONE_ACCENT: Record<ToastTone, string> = {
  success: "text-success",
  error: "text-destructive",
  info: "text-info",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, options?: ToastOptions) => {
      const id = nextId.current++;
      setItems((current) => [
        ...current,
        { id, tone, message, action: options?.action },
      ]);
      const duration = options?.duration ?? (options?.action ? 6000 : 5000);
      const timer = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({
    success: (message, options) => push("success", message, options),
    error: (message, options) => push("error", message, options),
    info: (message, options) => push("info", message, options),
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-(--z-toast) flex w-full max-w-sm flex-col gap-2"
      >
        {items.map((item) => {
          const Icon = TONE_ICON[item.tone];
          return (
            <div
              key={item.id}
              role={item.tone === "error" ? "alert" : "status"}
              className={cn(
                "pointer-events-auto flex items-start gap-3 rounded-lg border",
                "border-border bg-popover px-4 py-3 text-sm shadow-lg",
                "text-popover-foreground",
              )}
            >
              <Icon
                aria-hidden="true"
                className={cn("mt-0.5 size-4 shrink-0", TONE_ACCENT[item.tone])}
              />
              <span className="flex-1">{item.message}</span>
              {item.action && (
                <button
                  type="button"
                  className="hit-target shrink-0 font-medium text-primary hover:underline"
                  onClick={() => {
                    item.action?.onClick();
                    dismiss(item.id);
                  }}
                >
                  {item.action.label}
                </button>
              )}
              <button
                type="button"
                aria-label="Dismiss notification"
                className="hit-target shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => dismiss(item.id)}
              >
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
