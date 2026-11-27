// The "no such page" moment, in the manner of the record: a sheet drawn from the file with nothing entered on it, struck once.
// No black bars here: on a receipt a bar means something is withheld, and nothing is being withheld from this page.
import type { ReactNode } from "react";
import { SealMark } from "./SealMark";

export function NotOnRecord({ title, children, back, also }: { title: string; children: ReactNode; back: ReactNode; also?: ReactNode }) {
  return (
    <div className="page void-room">
      <div className="void-words">
        <h1>{title}</h1>
        {children}
        <p className="void-ways">
          <span className="void-back">{back}</span>
          {also}
        </p>
      </div>
      <div className="void-holder" aria-hidden="true">
        <div className="void-leaf">
          <div className="void-top">
            <span>Error 404</span>
            <SealMark />
          </div>
          <div className="void-lines">
            {["Entry", "Number", "Opened", "Outcome", "Receipt"].map(label => (
              <div key={label}><span>{label}</span><i /></div>
            ))}
          </div>
          <p className="void-stamp"><strong>Not on record</strong><span>nothing entered</span></p>
        </div>
      </div>
    </div>
  );
}

