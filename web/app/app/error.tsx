"use client";
// The last resort, for a fault in drawing a page. The record's own failures are handled before this (lib/record.ts).
export default function RecordError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="page room">
      <div className="notice">
        <h1>This page could not be drawn.</h1>
        <p>Something went wrong while setting out the record. The record itself is not affected.</p>
        <p><button type="button" onClick={reset} className="plain-button">Try again</button></p>
      </div>
    </div>
  );
}
