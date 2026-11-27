"use client";
// A question mark beside a term. Its explanation opens when the pointer rests on it, when the keyboard reaches it, or when it is pressed or tapped.
// A press keeps it open. It closes on Escape, on a press anywhere else, when focus moves on, or when the pointer leaves one that was only hovered.
// The explanation holds nothing that can take focus, so the keyboard passes straight through. Screen readers get the text as the button's description.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HELP, type HelpKey } from "@/lib/workshop/help";
import styles from "./HelpTip.module.css";

const OPENED = "conclave:helptip-open";
const GAP = 8;
const EDGE = 12;

/** an explanation from the Workshop's list by its key, or one given outright */
type Props = { term: HelpKey } | { label: string; text: string };

export function HelpTip(props: Props) {
  const { label, text } = "term" in props ? HELP[props.term] : props;
  const id = useId();
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = () => {
    clearTimeout(leaving.current);
    window.dispatchEvent(new CustomEvent(OPENED, { detail: id })); // one at a time
    setOpen(true);
  };
  const hide = useCallback(() => {
    clearTimeout(leaving.current);
    pinned.current = false;
    setOpen(false);
  }, []);
  // the pointer may cross from the mark to the explanation: leaving either one waits a moment
  const leave = () => {
    clearTimeout(leaving.current);
    leaving.current = setTimeout(() => { if (!pinned.current && !button.current?.matches(":focus-visible")) hide(); }, 140);
  };

  useEffect(() => () => clearTimeout(leaving.current), []);

  useEffect(() => {
    const other = (e: Event) => { if ((e as CustomEvent<string>).detail !== id) hide(); };
    window.addEventListener(OPENED, other);
    return () => window.removeEventListener(OPENED, other);
  }, [id, hide]);

  // place it under the mark, or over it where there is no room below, and always wholly on the screen
  const place = useCallback(() => {
    const mark = button.current?.getBoundingClientRect();
    const box = bubble.current;
    if (!mark || !box) return;
    const width = document.documentElement.clientWidth;
    box.style.width = `${Math.min(304, width - 2 * EDGE)}px`;
    const own = box.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(mark.left + mark.width / 2 - own.width / 2, width - own.width - EDGE));
    const below = mark.bottom + GAP;
    const top = below + own.height > window.innerHeight - EDGE && mark.top - GAP - own.height >= EDGE ? mark.top - GAP - own.height : below;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); hide(); } };
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !bubble.current?.contains(t)) hide();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, hide, place]);

  return (
    <span className={styles.tip} data-needs-script="">
      <button
        ref={button}
        type="button"
        className={styles.mark}
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => {
          if (pinned.current) hide();
          else { show(); pinned.current = true; }
        }}
        onFocus={e => { if (e.currentTarget.matches(":focus-visible")) show(); }}
        onBlur={hide}
        onPointerEnter={e => { if (e.pointerType === "mouse") show(); }}
        onPointerLeave={e => { if (e.pointerType === "mouse") leave(); }}
      >
        <span aria-hidden="true">?</span>
      </button>
      <span id={id} hidden>{text}</span>
      {open && createPortal(
        <div
          ref={bubble}
          className={styles.bubble}
          data-tip=""
          aria-hidden="true"
          onPointerEnter={() => clearTimeout(leaving.current)}
          onPointerLeave={e => { if (e.pointerType === "mouse") leave(); }}
        >
          {text}
        </div>,
        button.current?.closest("[data-tip-root]") ?? document.body,
      )}
    </span>
  );
}
