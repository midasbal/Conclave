import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { display, text, mono } from "@/lib/fonts";
import { WalletProviders } from "@/components/WalletProviders";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Conclave: a league for sealed trading strategies", template: "%s | Conclave" },
  description: "Players seal a trading strategy inside a private rollup. A random seed draws synthetic markets, every strategy runs through them, and a receipt records the result. Solana devnet, not audited.",
};

export const viewport: Viewport = { themeColor: "#e5e8e2" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${mono.variable}`} data-scroll-behavior="smooth">
      <body>
        <a href="#content" className="skip">Skip to content</a>
        <WalletProviders>
          <SiteHeader />
          <main id="content">{children}</main>
          <SiteFooter />
        </WalletProviders>
      </body>
    </html>
  );
}
