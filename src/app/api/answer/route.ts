import { submitAnswer, SUBJECT_KIND as ANSWER_SUBJECT } from "@/modules/answer/service";
import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { dispatchAction } from "@/platform/commands/registry";
import { mutationEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/answer` — the spec's `/answer bountii <id> <url>`, as an endpoint.
 *
 * Two things happen and only one of them is fast. Recording the submission is a
 * database write, so it is synchronous and the bounty is `IN_REVIEW` by the
 * time this returns. Fetching and hashing a stranger's URL can easily outlive a
 * request budget, so that part becomes a job: the response is 202 with a job id
 * to poll at `GET /api/jobs/<id>`, and the hash lands on the answer record.
 *
 * With a bounty id this goes through `@bountyboard answer`, so it gets the same
 * authorization as the mention. Without one it records a free-standing answer
 * to a musebook post, which moves nothing.
 */
export async function POST(request: Request) {
  return mutationEndpoint(
    request,
    "POST /api/answer",
    async ({ actor, caller, body }) => {
      const bountyId = body.bountyId ?? body.id;
      const url = String(body.url ?? "");

      if (bountyId) {
        const outcome = await dispatchAction(
          "bountyboard",
          "answer",
          {
            id: String(bountyId),
            url,
            wallet: String(body.wallet ?? body.rewardAddress ?? ""),
          },
          { actor, assurance: caller.assurance, origin: "direct" },
        );
        const { jobId } = await submitAnswer({
          actor,
          subject: `bounty:${bountyId}`,
          url,
          note: typeof body.note === "string" ? body.note : undefined,
        });
        return {
          status: 202,
          body: {
            object: "command_result",
            command: "bountyboard answer",
            message: outcome.message,
            data: outcome.data ?? null,
            // Lifted out of `data` as well so a caller reading the envelope
            // cannot miss a blocked payout while waiting on the hash job.
            payout: (outcome.data as { payout?: unknown } | null)?.payout ?? null,
            release_requires_evm_signature:
              (outcome.data as { release_requires_evm_signature?: boolean } | null)
                ?.release_requires_evm_signature ?? false,
            job: { id: jobId, status: "queued", poll: `/api/jobs/${jobId}` },
          },
          receiptSubject: { kind: SUBJECT_KIND, id: String(bountyId) },
        };
      }

      const { answer, jobId } = await submitAnswer({
        actor,
        subject: String(body.subject ?? ""),
        url,
        note: typeof body.note === "string" ? body.note : undefined,
      });
      return {
        status: 202,
        body: {
          object: "answer",
          answer: {
            id: answer.id,
            object: "answer",
            status: answer.status,
            muse: answer.muse,
            subject: answer.subject,
            url: answer.url,
            note: answer.note,
            contentHash: answer.contentHash,
            createdAt: answer.createdAt.toISOString(),
          },
          job: { id: jobId, status: "queued", poll: `/api/jobs/${jobId}` },
        },
        receiptSubject: { kind: ANSWER_SUBJECT, id: answer.id },
      };
    },
  );
}
