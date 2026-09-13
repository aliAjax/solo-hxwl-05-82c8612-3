import { useEffect, useState, type ReactNode } from "react";

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className={`field ${error ? "has-error" : ""}`}>
      <span className="field-label">
        {label}
        {hint && <em className="field-hint">{hint}</em>}
      </span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input {...props} className={`input ${props.className ?? ""}`} />;
}

export function useFormGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}

export function useConfirm(): {
  ask: (msg: string, onYes: () => void) => void;
  node: JSX.Element;
} {
  const [state, setState] = useState<{ msg: string; yes: () => void } | null>(null);
  const node = (
    <Modal
      open={!!state}
      title="请确认"
      onClose={() => setState(null)}
      footer={
        <>
          <button className="btn" onClick={() => setState(null)}>
            取消
          </button>
          <button
            className="btn danger"
            onClick={() => {
              state?.yes();
              setState(null);
            }}
          >
            确定
          </button>
        </>
      }
    >
      <p>{state?.msg}</p>
    </Modal>
  );
  return { ask: (msg, yes) => setState({ msg, yes }), node };
}
