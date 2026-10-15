import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Second Brain",
  description: "Bộ nhớ cá nhân chạy trên máy: thu thập, tìm kiếm và hỏi đáp có trích dẫn.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" data-theme="dark">
      <body className="min-h-screen bg-canvas text-ink">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
