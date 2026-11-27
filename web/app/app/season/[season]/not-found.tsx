import Link from "next/link";
import { NotOnRecord } from "@/components/NotOnRecord";

export default function SeasonNotFound() {
  return (
    <NotOnRecord title="No season with this number is on record." back={<Link href="/app">All seasons</Link>} also={<Link href="/docs/using#receipt">How to read a receipt</Link>}>
      <p>The record holds the receipts the service has verified. A mistyped number, or a season it has never read, will not be here.</p>
    </NotOnRecord>
  );
}
