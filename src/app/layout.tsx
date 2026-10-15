import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Second Brain",
  description: "A personal memory that runs on your machine: capture, search and ask with citations.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body className="min-h-screen bg-canvas text-ink">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
