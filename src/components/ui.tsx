"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { isSubmitComboKey, isSubmitKey } from "@/lib/core/keys";

/**
 * Minimal UI kit shared by every screen. Deliberately hand-rolled: no component
 * library means no version churn for a long-lived personal tool.
 */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-5 shadow-soft ${className}`}>{children}</section>
  );
}

export function CardTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <header className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{children}</h2>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </header>
  );
}

type ButtonVariant = "primary" | "ghost" | "danger" | "subtle";

export function Button({
  children,
  onClick,
  variant = "subtle",
  type = "button",
  disabled = false,
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const styles: Record<ButtonVariant, string> = {
    primary: "bg-accent text-white hover:opacity-90",
    subtle: "border border-line bg-raised text-ink hover:border-accent/60",
    ghost: "text-muted hover:text-ink",
    danger: "border border-warn/60 text-warn hover:bg-warn/10",
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  className = "",
  onEnter,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
  onEnter?: () => void;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (onEnter && isSubmitKey(event)) onEnter();
      }}
      className={`w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent/70 ${className}`}
    />
  );
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  className = "",
  onEnter,
  onSubmitCombo,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  /** Enter submits; Shift+Enter and IME composition do not — see lib/core/keys. */
  onEnter?: () => void;
  /** Ctrl/⌘+Enter submits; a bare Enter still types a newline. */
  onSubmitCombo?: () => void;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (onEnter && isSubmitKey(event)) onEnter();
        if (onSubmitCombo && isSubmitComboKey(event)) onSubmitCombo();
      }}
      className={`w-full resize-y rounded-xl border border-line bg-raised px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted focus:border-accent/70 ${className}`}
    />
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" | "good" }) {
  const tones = {
    neutral: "border-line text-muted",
    accent: "border-accent/50 text-accent",
    warn: "border-warn/50 text-warn",
    good: "border-good/50 text-good",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface/60 p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-md text-xs text-muted">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label ?? "Loading…"}
    </span>
  );
}

export function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "good" }) {
  const tones = {
    neutral: "border-line bg-raised text-muted",
    warn: "border-warn/50 bg-warn/10 text-warn",
    good: "border-good/50 bg-good/10 text-good",
  } as const;
  return <div className={`rounded-xl border px-3 py-2 text-xs ${tones[tone]}`}>{children}</div>;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl border border-line bg-raised p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
            active === tab.id ? "bg-accent text-white" : "text-muted hover:text-ink"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-muted">{item.label}</dt>
          <dd className="min-w-0 break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function useAsyncAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    setPending(true);
    setError(null);
    try {
      const value = await action();
      setResult(value);
      return value;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setPending(false);
    }
  }

  return { pending, error, result, run, setError };
}

/** Small fetch helper that unwraps the API error envelope. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const envelope = payload as { error?: { message?: string; code?: string } } | null;
    throw new Error(envelope?.error?.message ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const stored = window.localStorage.getItem("sb-theme");
    const initial = stored === "light" ? "light" : "dark";
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);
  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("sb-theme", next);
  }
  return { theme, toggle };
}

export function NavLink({ href, label, hint, icon }: { href: string; label: string; hint?: string; icon: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/" && pathname.startsWith(href));
  return (
    <Link
      href={href}
      className={`group flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition ${
        active ? "bg-raised text-ink" : "text-muted hover:bg-raised/60 hover:text-ink"
      }`}
    >
      <span className={`grid h-6 w-6 place-items-center rounded-lg border text-[13px] ${active ? "border-accent/60 text-accent" : "border-line"}`}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </Link>
  );
}
