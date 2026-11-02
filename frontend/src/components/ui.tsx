import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CloudOff, RefreshCw, X } from "lucide-react";
import { ApiError, type ClaimStatus, type EntityType } from "../api";
import { avatarBg, ETYPES, initials, pct, STATUS, type Shape } from "../vocab";

const SHAPE_PATHS: Record<Shape, (c: string) => ReactNode> = {
  circle: c => <circle cx="6" cy="6" r="5" fill={c} />,
  square: c => <rect x="1" y="1" width="10" height="10" rx="1.5" fill={c} />,
  diamond: c => <polygon points="6,0.5 11.5,6 6,11.5 0.5,6" fill={c} />,
  triangle: c => <polygon points="6,1 11.4,10.8 0.6,10.8" fill={c} />,
  hexagon: c => <polygon points="3,1 9,1 11.6,6 9,11 3,11 0.4,6" fill={c} />,
  pentagon: c => <polygon points="6,0.6 11.5,4.6 9.4,11.2 2.6,11.2 0.5,4.6" fill={c} />,
  ring: c => <circle cx="6" cy="6" r="4" fill="none" stroke={c} strokeWidth="2.4" />,
  doc: c => <rect x="1.5" y="0.8" width="9" height="10.4" rx="1" fill="none" stroke={c} strokeWidth="1.8" />,
  star: c => <polygon points="6,0.4 7.5,4.2 11.6,4.4 8.4,7 9.5,11 6,8.8 2.5,11 3.6,7 0.4,4.4 4.5,4.2" fill={c} />,
  octagon: c => <polygon points="3.6,0.8 8.4,0.8 11.2,3.6 11.2,8.4 8.4,11.2 3.6,11.2 0.8,8.4 0.8,3.6" fill="none" stroke={c} strokeWidth="2" />,
  cross: c => <polygon points="4.4,0.8 7.6,0.8 7.6,4.4 11.2,4.4 11.2,7.6 7.6,7.6 7.6,11.2 4.4,11.2 4.4,7.6 0.8,7.6 0.8,4.4 4.4,4.4" fill={c} />,
};

export const ShapeIcon = ({ type, size = 12 }: { type: EntityType; size?: number }) => (
  <svg viewBox="0 0 12 12" width={size} height={size} aria-hidden="true" style={{ flex: "none" }}>
    {SHAPE_PATHS[ETYPES[type]?.shape ?? "circle"](`var(--${type})`)}
  </svg>
);

export const EtypeTag = ({ type }: { type: EntityType }) => (
  <span className="etype"><ShapeIcon type={type} />{ETYPES[type]?.label ?? type}</span>
);

export const StatusBadge = ({ status }: { status: ClaimStatus | string }) => {
  const s = STATUS[status as ClaimStatus];
  return <span className={`badge ${s?.cls ?? ""}`}><i />{s?.label ?? status}</span>;
};

export const CaseStatusBadge = ({ status }: { status: string }) => (
  <span className={`badge ${({ Active: "b-acc", Review: "b-warn", Complete: "b-ok" } as Record<string, string>)[status] ?? ""}`}><i />{status}</span>
);

export const ConfBar = ({ value }: { value: number }) => (
  <div className="conf"><div className="bar"><i style={{ width: `${value * 100}%`, background: value >= 0.75 ? "var(--ok)" : value >= 0.5 ? "var(--warn)" : "var(--err)" }} /></div><span>{pct(value)}</span></div>
);

export const Avatar = ({ name, size = 28 }: { name: string; size?: number }) => (
  <span className="avatar" style={{ background: avatarBg(name), width: size, height: size }}>{initials(name)}</span>
);

export const Empty = ({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children?: ReactNode }) => (
  <div className="empty">{icon}<h3>{title}</h3><p className="small" style={{ maxWidth: "44ch" }}>{text}</p>{children}</div>
);

/** True when the API answered 503: a backing service (e.g. the graph database) is down, not "no data". */
export const isUnavailable = (e: unknown) => e instanceof ApiError && e.status === 503;

export const Unavailable = ({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying?: boolean }) => (
  <Empty icon={<CloudOff />} title="Graph database unavailable" text={(error as Error).message}>
    <button className="btn" onClick={onRetry} disabled={retrying}><RefreshCw />{retrying ? "Retrying…" : "Try again"}</button>
  </Empty>
);

export const DemoFlag = ({ children }: { children: ReactNode }) => <div className="demo-flag"><AlertTriangle />{children}</div>;

export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;

export function Modal({ title, sub, children, onClose, footer, wide }: {
  title: string; sub?: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="modal-bg" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h"><div className="grow"><h2>{title}</h2>{sub && <p className="small muted mt8">{sub}</p>}</div>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close"><X /></button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>, document.body);
}

export function Drawer({ title, sub, children, onClose }: { title: string; sub?: string; children: ReactNode; onClose: () => void }) {
  const [show, setShow] = useState(false);
  useEffect(() => { requestAnimationFrame(() => setShow(true)); }, []);
  const close = useCallback(() => { setShow(false); setTimeout(onClose, 220); }, [onClose]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [close]);
  return createPortal(<>
    <div className={`drawer-bg ${show ? "show" : ""}`} onClick={close} />
    <aside className={`drawer ${show ? "show" : ""}`} role="dialog" aria-label={title}>
      <div className="drawer-h"><div className="grow" style={{ minWidth: 0 }}><h2 className="trunc">{title}</h2>{sub && <div className="xs dim">{sub}</div>}</div>
        <button className="btn ghost icon sm" onClick={close} aria-label="Close"><X /></button></div>
      <div className="drawer-b">{children}</div>
    </aside></>, document.body);
}

type ToastKind = "" | "ok" | "err" | "warn";
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  const n = useRef(0);
  const push = useCallback((msg: string, kind: ToastKind = "") => {
    const id = ++n.current;
    setItems(x => [...x, { id, msg, kind }]);
    setTimeout(() => setItems(x => x.filter(t => t.id !== id)), 3600);
  }, []);
  return <ToastCtx.Provider value={push}>{children}
    <div className="toasts" aria-live="polite">{items.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}</div>
  </ToastCtx.Provider>;
}
