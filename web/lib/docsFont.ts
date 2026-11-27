// The docs' reading face. Caslon keeps the headings and the brand; Source Serif carries long prose, being sturdier and more open at text sizes.
// It is not preloaded: the links to the docs in the header make other pages fetch that route ahead of time, and a preload would have every page download
// these files. Without one, they are fetched only where text is actually set in them.
import localFont from "next/font/local";

export const reading = localFont({
  src: [
    { path: "../node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-400-italic.woff2", weight: "400", style: "italic" },
    { path: "../node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-reading",
  display: "swap",
  preload: false,
  fallback: ["Georgia", "serif"],
});
