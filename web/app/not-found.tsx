import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "No such page" };

export default function NotFound() {
  return (
    <div className="page room">
      <div className="notice">
        <h1>There is no such page.</h1>
        <p><Link href="/">Back to the entrance</Link></p>
      </div>
    </div>
  );
}
