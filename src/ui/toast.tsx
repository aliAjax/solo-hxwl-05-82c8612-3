import { useEffect, useRef, useState } from "react";
import { store } from "../core/store";

export function useUndoHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        store.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  action2?: { label: string; run: () => void };
}

let toastSeq = 1;

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): JSX.Element {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          <div className="toast-actions">
            {t.action && (
              <button
                className="link-btn"
                onClick={() => {
                  t.action!.run();
                  onDismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.action2 && (
              <button
                className="link-btn"
                onClick={() => {
                  t.action2!.run();
                  onDismiss(t.id);
                }}
              >
                {t.action2.label}
              </button>
            )}
            <button className="link-btn muted" onClick={() => onDismiss(t.id)}>
              关闭
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function useToasts(): {
  toasts: Toast[];
  push: (text: string, action?: Toast["action"], action2?: Toast["action2"]) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const dismiss = (id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) clearTimeout(tm);
  };
  const push = (text: string, action?: Toast["action"], action2?: Toast["action2"]) => {
    const id = toastSeq++;
    setToasts((ts) => [...ts.slice(-3), { id, text, action, action2 }]);
    timers.current.set(
      id,
      setTimeout(() => dismiss(id), 12000),
    );
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return { toasts, push, dismiss };
}
