"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { Badge, NavLink, api } from "./ui";

type Stats = {
  documents: number;
  chunks: number;
  notes: number;
  embeddings: number;
  connectors: number;
  aiConfigured: boolean;
  embeddingCoverage: number;
};

const NAV = [
  { href: "/", label: "Tổng quan", icon: "◍" },
  { href: "/notes", label: "Ghi chú", icon: "✎" },
  { href: "/library", label: "Thư viện", icon: "▤" },
  { href: "/search", label: "Tìm kiếm", icon: "⌕" },
  { href: "/chat", label: "Hỏi đáp", icon: "✦" },
  { href: "/plays", label: "Tự động hoá", icon: "⚙" },
  { href: "/connectors", label: "Kết nối", icon: "⧉" },
  { href: "/import", label: "Nhập dữ liệu", icon: "↧" },
  { href: "/timeline", label: "Dòng thời gian", icon: "≡" },
  { href: "/graph", label: "Bản đồ tri thức", icon: "◈" },
  { href: "/settings", label: "Cài đặt", icon: "⚒" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("sb-theme");
    const initial = stored === "light" ? "light" : "dark";
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
    api<Stats>("/api/v1/stats")
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("sb-theme", next);
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1500px] gap-6 px-4 py-5 lg:px-8">
      <aside className={`${navOpen ? "block" : "hidden"} lg:block lg:w-64 lg:shrink-0`}>
        <div className="sticky top-5 flex h-[calc(100vh-2.5rem)] flex-col rounded-2xl border border-line bg-surface p-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold tracking-tight">Second Brain</p>
              <p className="text-[11px] text-muted">Bộ nhớ cá nhân · local-first</p>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              title="Đổi giao diện sáng/tối"
              className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:text-ink"
            >
              {theme === "dark" ? "☾" : "☀"}
            </button>
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto">
            {NAV.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} icon={item.icon} />
            ))}
          </nav>

          <div className="mt-4 space-y-2 border-t border-line pt-3 text-[11px] text-muted">
            <div className="flex items-center justify-between">
              <span>Tài liệu</span>
              <span className="tabular-nums text-ink">{stats?.documents ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Đoạn chỉ mục</span>
              <span className="tabular-nums text-ink">{stats?.chunks ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Embedding</span>
              <span className="tabular-nums text-ink">
                {stats ? `${Math.round(stats.embeddingCoverage * 100)}%` : "—"}
              </span>
            </div>
            <div className="pt-1">
              {stats?.aiConfigured ? <Badge tone="good">AI đã bật</Badge> : <Badge tone="warn">Chế độ từ khoá</Badge>}
            </div>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 pb-10">
        <button
          type="button"
          onClick={() => setNavOpen((open) => !open)}
          className="mb-3 rounded-xl border border-line px-3 py-1.5 text-xs text-muted lg:hidden"
        >
          {navOpen ? "Đóng menu" : "Mở menu"}
        </button>
        {children}
      </main>
    </div>
  );
}
