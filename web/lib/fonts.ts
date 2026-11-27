// Two voices. Libre Caslon is a revival of the face long used to print official records: it carries the page.
// IBM Plex Mono is for what a machine wrote down: identifiers, hashes, field names.
// Both are served from this site (installed packages, no request to a font host).
import localFont from "next/font/local";

export const display = localFont({
  src: "../node_modules/@fontsource/libre-caslon-display/files/libre-caslon-display-latin-400-normal.woff2",
  weight: "400",
  variable: "--font-display",
  display: "swap",
  fallback: ["Georgia", "serif"],
});

export const text = localFont({
  src: [
    { path: "../node_modules/@fontsource/libre-caslon-text/files/libre-caslon-text-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../node_modules/@fontsource/libre-caslon-text/files/libre-caslon-text-latin-400-italic.woff2", weight: "400", style: "italic" },
    { path: "../node_modules/@fontsource/libre-caslon-text/files/libre-caslon-text-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-text",
  display: "swap",
  fallback: ["Georgia", "serif"],
});

export const mono = localFont({
  src: [
    { path: "../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
  fallback: ["ui-monospace", "monospace"],
});
