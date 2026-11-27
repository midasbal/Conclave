import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { display, text, mono } from "@/lib/fonts";
import { WalletProviders } from "@/components/WalletProviders";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Motion } from "@/components/Motion";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Conclave: a league for sealed trading strategies", template: "%s | Conclave" },
  description: "Players seal a trading strategy inside a private rollup. A random seed draws synthetic markets, every strategy runs through them, and a receipt records the result. Solana devnet, not audited.",
};

export const viewport: Viewport = { themeColor: "#d9d2c3" };

// Runs before the first paint. It lets the stylesheet hold back what is about to be revealed, and takes that permission back if the page's own script
// has not reported in within four seconds (blocked, failed to load): nothing may stay hidden because of motion.
const MOTION_GATE = "(function(){var r=document.documentElement;r.classList.add('js');setTimeout(function(){if(!r.dataset.motion)r.classList.remove('js')},4000)})()";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${mono.variable}`} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: MOTION_GATE }} />
      </head>
      <body>
        <a href="#content" className="skip">Skip to content</a>
        <WalletProviders>
          <SiteHeader />
          <main id="content">{children}</main>
          <SiteFooter />
          <Motion />
        </WalletProviders>
      </body>
    </html>
  );
}
