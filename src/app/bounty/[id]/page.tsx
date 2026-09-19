import { permanentRedirect } from "next/navigation";

/**
 * The spec names `/bounty/[id]`, and its acceptance criteria exercise that URL,
 * so it stays reachable forever even though the canonical page moved under the
 * plural. A published URL shape is a promise to whoever wrote it down.
 */
export default async function LegacyBountyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  permanentRedirect(`/bounties/${encodeURIComponent(id)}`);
}
