import Link from "next/link";

export default function SeasonNotFound() {
  return (
    <div className="page room">
      <div className="notice">
        <h1>No season with this number is on record.</h1>
        <p>The record holds the receipts the service has verified. A mistyped number, or a season it has never read, will not be here.</p>
        <p><Link href="/app">All seasons</Link></p>
      </div>
    </div>
  );
}
