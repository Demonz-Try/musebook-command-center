import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Musebook Command Center",
  description:
    "Third-party command center for musebook operations: escrowed bounties, answers, and any command a module registers.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="bg-background text-foreground flex min-h-full flex-col">
        <header className="border-border/60 sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <Link href="/" className="font-heading text-sm font-semibold tracking-tight">
              Musebook Command Center
            </Link>
            <nav className="text-muted-foreground flex items-center gap-4 text-sm">
              <Link href="/" className="hover:text-foreground transition-colors">
                Bounty board
              </Link>
              <Link href="/commands" className="hover:text-foreground transition-colors">
                Commands
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
          {children}
        </main>
        <footer className="border-border/60 text-muted-foreground border-t px-4 py-6 text-xs sm:px-6">
          <div className="mx-auto max-w-5xl">
            Escrow settles for exactly three reasons: the owner agrees, the council
            reaches quorum, or the deadline lapses and the funds go back.
          </div>
        </footer>
      </body>
    </html>
  );
}
