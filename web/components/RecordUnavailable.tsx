// What is shown when there is no record to show. It never stands in sample data for the real thing.
import Link from "next/link";
import type { Problem } from "@/lib/record";
import { links } from "@/lib/links";

const SAY: Record<Exclude<Problem, "not-found">, { title: string; body: string; retry: boolean }> = {
  unconfigured: { title: "The record is not connected here.", body: "This copy of the app has not been given a record service to read, so there are no seasons to show.", retry: false },
  unreachable: { title: "The record service did not answer.", body: "The seasons are kept by a separate service, and it could not be read just now. Nothing about the record itself has changed.", retry: true },
  "no-record": { title: "There is no record yet.", body: "The record service is running but has not finished reading a first record.", retry: true },
  unexpected: { title: "The record could not be read.", body: "The service answered with something this page does not recognise as the record, so none of it is shown.", retry: true },
};

export function RecordUnavailable({ problem, retryHref }: { problem: Exclude<Problem, "not-found">; retryHref: string }) {
  const say = SAY[problem];
  return (
    <div className="page room">
      <div className="notice">
        <h1>{say.title}</h1>
        <p>{say.body}</p>
        {/* a plain link on purpose: a full request, not the router's remembered copy of this failure */}
        {say.retry && <p><a href={retryHref}>Try again</a></p>}
        <p>Receipts are public on Solana devnet and can be rebuilt without this service: see <a href={links.proofs}>records and proofs</a>.</p>
        <p><Link href="/">Back to the entrance</Link></p>
      </div>
    </div>
  );
}
