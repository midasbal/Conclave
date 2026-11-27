"use client";
// A plain textarea laid exactly over a ruled copy of its own text. The copy gives the line numbers, marks the lines with errors and underlines the
// column; the textarea keeps everything a browser's editor already does well: selection, undo, spelling off, the keyboard, screen readers.
// Both wrap identically, so a line number stays beside its line at any width. Tab is left alone, so the keyboard can always leave.
import { forwardRef, type KeyboardEvent } from "react";
import type { Diagnostic } from "@/lib/engine/types";
import styles from "./Editor.module.css";

type Props = { value: string; errors: Diagnostic[]; warnings: Diagnostic[]; readOnly: boolean; onChange: (v: string) => void; onRun: () => void };

export const Editor = forwardRef<HTMLTextAreaElement, Props>(function Editor({ value, errors, warnings, readOnly, onChange, onRun }, ref) {
  const lines = value.split("\n");
  const errorAt = new Map<number, number>();
  for (const e of errors) if (!errorAt.has(e.line)) errorAt.set(e.line, e.col);
  const warned = new Set(warnings.map(w => w.line));

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onRun();
    }
  };

  return (
    <div className={styles.frame}>
      <div className={styles.scroller}>
        <div className={styles.stack}>
          <ol className={styles.ruled} aria-hidden="true">
            {lines.map((line, i) => {
              const col = errorAt.get(i + 1);
              const chars = Array.from(line);
              const at = col === undefined ? -1 : Math.min(Math.max(col - 1, 0), chars.length);
              return (
                <li key={i} className={col !== undefined ? styles.error : warned.has(i + 1) ? styles.warning : undefined} data-line={i + 1}>
                  <span className={styles.number}>{i + 1}</span>
                  {at < 0 ? line || "​" : <>{chars.slice(0, at).join("")}<mark>{chars[at] ?? " "}</mark>{chars.slice(at + 1).join("")}</>}
                </li>
              );
            })}
          </ol>
          <textarea
            ref={ref}
            id="strategy-source"
            className={styles.input}
            value={value}
            readOnly={readOnly}
            onChange={e => onChange(e.target.value)}
            onKeyDown={keys}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            aria-label="Strategy source, one instruction per line"
            aria-invalid={errors.length > 0}
            aria-describedby="diagnostics"
          />
        </div>
      </div>
    </div>
  );
});
