"use client";
// The way in, to sealing. It is drawn as a pair of doors: a label and a leaf beside it, shut against each other with a hairline seam.
// Pointing at it, or reaching it by keyboard, opens the seam a little; pressing it shuts it again.
// The Enter key opens it too, but only while the doors are on screen and nothing else holds the focus, so it never takes over another control.
import Link from "next/link";
import { useEffect, useRef } from "react";
import styles from "./EnterButton.module.css";

export function EnterButton() {
  const door = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const held = document.activeElement;
      if (held && held !== document.body && held !== document.documentElement) return;
      const box = door.current?.getBoundingClientRect();
      if (!box || box.bottom <= 0 || box.top >= window.innerHeight) return;
      e.preventDefault();
      door.current?.click();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  return (
    // not fetched ahead of time: that would preload the seal page's stylesheet here
    <Link ref={door} href="/seal" prefetch={false} className={styles.enter}>
      <span className={styles.label}>Seal a strategy</span>
      <span className={styles.leaf} aria-hidden="true">
        <svg viewBox="0 0 20 12" width="20" height="12"><path d="M0 6h17M12.5 1.2 17.8 6l-5.3 4.8" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </span>
    </Link>
  );
}
