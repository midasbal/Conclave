"use client";
// The only script behind the page's movement. It marks things as they come on screen; CSS does the rest.
//   [data-reveal]  a section entering view, once
//   [data-seal]    the receipt's sealing: it starts when most of the sheet is visible and the typefaces have arrived, and it runs once per visit.
//                  Coming back to the page later in the same visit shows the record already sealed.
import { usePathname } from "next/navigation";
import { useEffect } from "react";

let sealedThisVisit = false;

export function Motion() {
  const path = usePathname();
  useEffect(() => {
    document.documentElement.dataset.motion = "on"; // tells the early script in the layout that this one arrived
    const reveals = [...document.querySelectorAll<HTMLElement>("[data-reveal]:not([data-shown])")];
    const seals = [...document.querySelectorAll<HTMLElement>("[data-seal]:not([data-shown])")];
    if (!("IntersectionObserver" in window)) {
      for (const el of [...reveals, ...seals]) el.dataset.shown = "done";
      return;
    }
    let live = true;
    const reveal = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        (e.target as HTMLElement).dataset.shown = "";
        reveal.unobserve(e.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    const seal = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        seal.unobserve(e.target);
        void document.fonts.ready.then(() => {
          if (!live) return;
          (e.target as HTMLElement).dataset.shown = "play";
          sealedThisVisit = true;
        });
      }
    }, { threshold: 0.45 });
    for (const el of reveals) reveal.observe(el);
    for (const el of seals) {
      if (sealedThisVisit) el.dataset.shown = "done";
      else seal.observe(el);
    }
    return () => { live = false; reveal.disconnect(); seal.disconnect(); };
  }, [path]);
  return null;
}
