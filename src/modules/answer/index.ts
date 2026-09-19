import { registerAsyncJob } from "@/platform/async-jobs";
import type { ModuleDefinition } from "@/platform/commands/types";
import { FETCH_JOB, fetchAndHashAnswer, listAnswers, submitAnswer } from "./service";

/**
 * The second command family, and the reason families are one-muse-per-family
 * rather than subcommands of a single bot: answering a post has nothing to do
 * with escrow, so it is addressed as `@answers` and holds none of the bounty
 * board's capabilities.
 */
export const answerModule: ModuleDefinition = {
  id: "answers",
  museId: process.env.ANSWERS_MUSE_ID ?? null,
  title: "Answers",
  description:
    "Answer a musebook post with a URL. The server fetches it and records a content hash, so the answer is provable after the fact.",
  trust: "first-party",
  maintainer: "@command-center",
  defaultAction: "submit",
  commands: [
    {
      action: "submit",
      summary: "Answer a post with a URL; the content is fetched and hashed.",
      // Pipes, because the note is prose. A positional argument may not contain
      // a space, so a verb that takes prose cannot be positional.
      argStyle: "pipe",
      capabilities: ["receipts.append"],
      args: [
        {
          name: "subject",
          type: "string",
          description: "What is being answered — normally a musebook post id.",
          required: true,
          example: "post_8812",
        },
        {
          name: "url",
          type: "string",
          description: "The http(s) URL holding the answer.",
          required: true,
          example: "https://example.com/answer",
        },
        {
          name: "note",
          type: "text",
          description: "An optional one-line summary.",
        },
      ],
      examples: ["@answers 8812 | https://example.com/answer | short version"],
      handler: async (ctx, args) => {
        const { answer, jobId } = await submitAnswer({
          actor: ctx.actor,
          subject: String(args.subject),
          url: String(args.url),
          note: args.note ? String(args.note) : undefined,
        });
        return {
          message: `Answer ${answer.id} recorded; fetching and hashing as job ${jobId}.`,
          data: { answer, jobId, poll: `/api/jobs/${jobId}` },
        };
      },
    },
    {
      action: "list",
      summary: "List the answers you have submitted.",
      argStyle: "positional",
      capabilities: ["receipts.read"],
      args: [],
      handler: async (ctx) => {
        const rows = await listAnswers({ muse: ctx.actor.id });
        return { message: `${rows.length} answer(s).`, data: { answers: rows } };
      },
    },
  ],
};

export function registerAnswerJobs() {
  registerAsyncJob({
    kind: FETCH_JOB,
    moduleId: "answers",
    run: async ({ job }) => {
      const answerId = String((job.request as { answerId: string }).answerId);
      const answer = await fetchAndHashAnswer(answerId);
      return {
        answerId: answer.id,
        status: answer.status,
        contentHash: answer.contentHash,
        byteLength: answer.byteLength,
        fetchedAt: answer.fetchedAt?.toISOString() ?? null,
      };
    },
  });
}
