"use client";
// The "On this page" list. The server renders plain links, which work without script. With it, the section being read is marked as the page moves,
// and the folded list on a narrow screen closes once a place is chosen.
import { useEffect, useState, type MouseEvent } from "react";

export type Entry = { id: string; title: string };

export function DocToc({ entries }: { entries: Entry[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const found = entries.map(e => document.getElementById(e.id)).filter((el): el is HTMLElement => el !== null);
      if (!found.length) return;
      // a section is being read once its top has passed this line, a little way down the window
      const line = Math.max(96, window.innerHeight * 0.3);
      let current = found[0];
      for (const el of found) if (el.getBoundingClientRect().top <= line) current = el;
      // at the foot of the page the last sections cannot reach that line: take the one asked for by its address if it is in view, or else the last
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        const asked = found.find(el => `#${el.id}` === window.location.hash && el.getBoundingClientRect().top >= 0);
        current = asked ?? found[found.length - 1];
      }
      setActive(current.id);
    };
    const later = () => { if (!frame) frame = window.requestAnimationFrame(read); };
    read();
    window.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    window.addEventListener("hashchange", later);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", later);
      window.removeEventListener("resize", later);
      window.removeEventListener("hashchange", later);
    };
  }, [entries]);

  // closing happens before the browser follows the link, so it scrolls to where the section is once the list is out of the way
  const choose = (e: MouseEvent<HTMLAnchorElement>) => {
    const fold = e.currentTarget.closest("details");
    if (fold) fold.open = false;
  };

  return (
    <ol>
      {entries.map(e => (
        <li key={e.id}>
          <a href={`#${e.id}`} aria-current={active === e.id ? "location" : undefined} onClick={choose}>{e.title}</a>
        </li>
      ))}
    </ol>
  );
}
