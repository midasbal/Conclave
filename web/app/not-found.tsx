import type { Metadata } from "next";
import Link from "next/link";
import { NotOnRecord } from "@/components/NotOnRecord";

export const metadata: Metadata = { title: "No such page" };

export default function NotFound() {
  return (
    <NotOnRecord title="There is no such page." back={<Link href="/">Back to the entrance</Link>} also={<><Link href="/app">The record</Link><Link href="/docs">Docs</Link></>}>
      <p>Nothing is filed at this address. It may have been mistyped, or the link that brought you here is out of date.</p>
    </NotOnRecord>
  );
}
