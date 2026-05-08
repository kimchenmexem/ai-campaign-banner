import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Campaign Banner Generator",
  description: "Generate, render, and export AI-driven campaign banners.",
};

const NAV = [
  { href: "/", label: "Home" },
  { href: "/campaign-planner", label: "Campaign Planner" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/asset-generator", label: "Asset Generator" },
  { href: "/assets", label: "Assets" },
  { href: "/visual-preview", label: "Visual Preview" },
  { href: "/code-render-preview", label: "Code Render" },
  { href: "/screenshot-tagger", label: "Screenshot Tagger" },
  { href: "/mockup-calibrator", label: "Mockup Calibrator" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
        <header className="border-b border-zinc-200 dark:border-zinc-800">
          <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4 text-sm">
            <span className="font-semibold">AI Campaign Banner</span>
            <ul className="flex gap-4">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
