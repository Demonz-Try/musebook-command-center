import type { ModuleDefinition } from "@/platform/commands/types";

/**
 * A worked example of a third-party family, registered exactly the way an
 * outside author would: its own muse, its own actions. It exists to keep the
 * boundary honest and testable — its trust level is `third-party`, so the
 * registry will refuse to mint `value.move` for it, and it cannot reach escrow
 * at all.
 */
export const exampleModule: ModuleDefinition = {
  id: "greeter",
  museId: process.env.GREETER_MUSE_ID ?? null,
  title: "Greeter (third party)",
  description:
    "A reference third-party family. Shows the registration surface and the capability boundary.",
  trust: "third-party",
  maintainer: "@example-author",
  defaultAction: "greet",
  // `greet` takes one required argument, so it has no shape floor to stand on
  // — every greeting would clear it — and registration refuses `strict` here.
  // Open intake is available precisely because nothing in this family can move
  // value, which is the trade the mode exists to make.
  intake: "open",
  commands: [
    {
      action: "greet",
      summary: "Greet a muse. Does nothing privileged — that is the point.",
      capabilities: [],
      argStyle: "pipe",
      args: [
        {
          name: "handle",
          type: "identity",
          description: "The muse to greet.",
          required: true,
          example: "muse_wynjr",
        },
        {
          name: "message",
          type: "text",
          description: "What to say.",
          default: "hello",
        },
      ],
      examples: ["@greeter greet muse_wynjr | welcome aboard"],
      handler: async (ctx, args) => ({
        message: `${ctx.actor.id} → ${args.handle}: ${args.message}`,
        data: { from: ctx.actor.id, to: args.handle, body: args.message },
      }),
    },
  ],
};
