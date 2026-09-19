import { and, desc, eq, inArray, or } from "drizzle-orm";
import { getDb } from "@/db";
import { receiptsByActor, type Receipt } from "@/platform/receipts";
import { normalizeHandle } from "@/platform/identity";
import { bounties, claims, councilVotes, submissions } from "./schema";
import type { Bounty, Claim, CouncilVote, Submission } from "./schema";
import { payability } from "./escrow";

/**
 * Read models shared by the board, the bounty page, the public muse profile and
 * the authenticated dashboard.
 *
 * These live here rather than inline in page components so there is exactly one
 * definition of "what is public about a muse" for every surface to agree on.
 * The dashboard's session-gated views are built by composing these with its own
 * private reads; it does not need a second copy of these queries, and a second
 * copy is how two surfaces end up disagreeing about the same fact.
 */

/**
 * What a muse has done, as opposed to what it has been asked to do.
 *
 * The line is "what you did is public, what you haven't done yet is private":
 * receipts and completed activity are a matter of record, while a decision
 * queue, an inbox and credentials are not. Nothing in this module reads any of
 * the latter, so it cannot leak them by accident.
 */
export interface PublicProfile {
  museId: string;
  posted: Bounty[];
  owned: Bounty[];
  answered: { submission: Submission; bounty: Bounty }[];
  votes: { vote: CouncilVote; bounty: Bounty }[];
  receipts: Receipt[];
  stats: {
    postedCount: number;
    fundedCount: number;
    answeredCount: number;
    paidCount: number;
    voteCount: number;
  };
}

export async function publicProfile(museId: string): Promise<PublicProfile> {
  const id = normalizeHandle(museId);
  const db = await getDb();

  const [authored, answeredRows, voteRows] = await Promise.all([
    db
      .select()
      .from(bounties)
      .where(or(eq(bounties.creator, id), eq(bounties.owner, id)))
      .orderBy(desc(bounties.createdAt)),
    db
      .select()
      .from(submissions)
      .where(eq(submissions.worker, id))
      .orderBy(desc(submissions.createdAt)),
    db
      .select()
      .from(councilVotes)
      .where(eq(councilVotes.voter, id))
      .orderBy(desc(councilVotes.createdAt)),
  ]);

  const referenced = [
    ...answeredRows.map((s) => s.bountyId),
    ...voteRows.map((v) => v.bountyId),
  ];
  const related = referenced.length
    ? await db.select().from(bounties).where(inArray(bounties.id, referenced))
    : [];
  const byId = new Map<string, Bounty>(
    [...authored, ...related].map((b) => [b.id, b as Bounty]),
  );

  const posted = (authored as Bounty[]).filter((b) => b.creator === id);
  const owned = (authored as Bounty[]).filter((b) => b.owner === id);
  const answered = (answeredRows as Submission[])
    .map((submission) => ({ submission, bounty: byId.get(submission.bountyId)! }))
    .filter((row) => row.bounty);
  const votes = (voteRows as CouncilVote[])
    .map((vote) => ({ vote, bounty: byId.get(vote.bountyId)! }))
    .filter((row) => row.bounty);

  // Receipts are the public record by construction: every state change writes
  // one, and the chain is what makes the history checkable by anyone.
  const receipts = await receiptsByActor(id);

  return {
    museId: id,
    posted,
    owned,
    answered,
    votes,
    receipts,
    stats: {
      postedCount: posted.length,
      fundedCount: owned.length,
      answeredCount: answered.length,
      paidCount: answered.filter((a) => a.bounty.status === "PAID").length,
      voteCount: votes.length,
    },
  };
}

/** Every submission on a bounty, with whether each one can actually be paid. */
export async function submissionsWithPayability(
  bountyId: string,
): Promise<{ submission: Submission; payable: boolean; reason: string | null }[]> {
  const db = await getDb();
  const [bounty] = await db.select().from(bounties).where(eq(bounties.id, bountyId));
  if (!bounty) return [];

  const rows = await db
    .select()
    .from(submissions)
    .where(eq(submissions.bountyId, bountyId))
    .orderBy(desc(submissions.createdAt));

  return (rows as Submission[]).map((submission) => {
    const { payable, reason } = payability(bounty as Bounty, submission);
    return { submission, payable, reason };
  });
}

/** Claims on a bounty, oldest first — first claim wins socially. */
export async function claimsFor(bountyId: string): Promise<Claim[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(claims)
    .where(eq(claims.bountyId, bountyId))
    .orderBy(claims.createdAt);
  return rows as Claim[];
}

/** One submission plus its bounty, for the proof endpoint and the dashboard. */
export async function submissionWithBounty(
  submissionId: string,
): Promise<{ submission: Submission; bounty: Bounty } | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(submissions)
    .innerJoin(bounties, eq(submissions.bountyId, bounties.id))
    .where(eq(submissions.id, submissionId));
  if (!row) return null;
  return { submission: row.submissions as Submission, bounty: row.bounties as Bounty };
}

/** Bounties a muse may still act on. Used by the board and the dashboard alike. */
export async function openBountiesFor(museId: string): Promise<Bounty[]> {
  const id = normalizeHandle(museId);
  const db = await getDb();
  const rows = await db
    .select()
    .from(bounties)
    .where(
      and(
        or(eq(bounties.creator, id), eq(bounties.owner, id)),
        inArray(bounties.status, ["OPEN", "FUNDED", "IN_REVIEW", "DISPUTED"]),
      ),
    )
    .orderBy(desc(bounties.createdAt));
  return rows as Bounty[];
}
