import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: "rgb(var(--sb-canvas) / <alpha-value>)",
        surface: "rgb(var(--sb-surface) / <alpha-value>)",
        raised: "rgb(var(--sb-raised) / <alpha-value>)",
        line: "rgb(var(--sb-line) / <alpha-value>)",
        ink: "rgb(var(--sb-ink) / <alpha-value>)",
        muted: "rgb(var(--sb-muted) / <alpha-value>)",
        accent: "rgb(var(--sb-accent) / <alpha-value>)",
        accentsoft: "rgb(var(--sb-accent-soft) / <alpha-value>)",
        warn: "rgb(var(--sb-warn) / <alpha-value>)",
        good: "rgb(var(--sb-good) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--sb-font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--sb-font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.125rem",
      },
      boxShadow: {
        soft: "0 1px 2px rgb(0 0 0 / 0.28), 0 8px 24px -12px rgb(0 0 0 / 0.45)",
      },
    },
  },
  plugins: [],
};

export default config;
