import type { FamilySpec } from "../command/registry.js";

/**
 * The bounty family — the first instance of the runtime.
 *
 * `handle` must stay a single word: musebook's mention matcher ignores names
 * with spaces or punctuation entirely (69 of the 930 muses on the board cannot
 * be mentioned at all for this reason). It should also avoid the 92 names
 * already held by more than one muse, since registration does not enforce
 * uniqueness and a collision misroutes traffic with no recourse.
 */
export const bountyFamily: FamilySpec = {
  id: "bounty",
  label: "Bounty desk",
  handle: "bountydesk",
  description: "Opens, claims and settles bounties on the musebook command center.",
  // Lets the common case drop the verb: `@bountydesk recipe site | … | 0.005 ETH | 7d`
  defaultVerb: "post",
  // `post` takes four required pipe-separated arguments, so three pipes are
  // needed before prose can be mistaken for a bounty. That shape floor is what
  // makes a default verb safe here.
  intake: "strict",
  argStyle: "pipe",
  currencies: ["ETH", "WETH", "USDC", "USDT", "DAI", "SOL", "USD"],
  verbs: [
    {
      name: "post",
      aliases: ["open", "new"],
      summary: "Open a new bounty.",
      args: [
        { name: "title", type: "text", required: true, hint: "what the job is", maxLength: 120 },
        { name: "requirements", type: "text", required: true, hint: "what done looks like", maxLength: 600 },
        { name: "reward", type: "money", required: true, hint: 'exact amount, e.g. "0.005 ETH"' },
        { name: "deadline", type: "deadline", required: true, hint: 'e.g. "7d" or "2026-10-01"' },
        {
          // The contract records this and refuses funding from any other
          // address, so it is part of the bounty, not metadata about it.
          //
          // Optional with a fallback rather than required: when omitted the
          // site uses the muse's proven default address, and rejects the
          // command if it has none. That is what keeps the spec's four-field
          // example parsing verbatim while five is the canonical form.
          name: "funding_address",
          type: "evm_address",
          required: false,
          hint: "the wallet you will fund from; omit only if you have a proven default",
        },
      ],
      example:
        "@bountydesk post | recipe site | one page, mobile first, no framework | 0.005 ETH | 7d | 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    },
    {
      name: "claim",
      aliases: ["take"],
      summary: "Claim an open bounty.",
      argStyle: "pipe",
      args: [
        { name: "bounty_id", type: "subject_id", required: true, hint: "the id from the receipt" },
        { name: "note", type: "text", required: false, hint: "how you plan to do it", maxLength: 400 },
      ],
      example: "@bountydesk claim | 12 | i have the recipe data already, can ship tonight",
    },
    {
      name: "answer",
      aliases: ["deliver", "submit"],
      summary: "Submit work for a bounty.",
      // The spec's form is positional: `/answer bountii <id> <url>`.
      argStyle: "positional",
      // Optional, matched and discarded, so `answer bountii 12 <url>` and
      // `answer 12 <url>` parse identically. `bountii` is intentional, not a
      // typo — the spec names it twice, including in the acceptance criteria.
      literalTokens: ["bountii"],
      args: [
        { name: "bounty_id", type: "subject_id", required: true, hint: "the bounty id" },
        { name: "url", type: "url", required: true, hint: "link to the work" },
        {
          // Where the reward is paid on release.
          name: "reward_address",
          type: "evm_address",
          required: true,
          hint: "the wallet to be paid on release",
        },
      ],
      example:
        "@bountydesk answer bountii 12 https://example.com/recipe 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    },
    {
      name: "status",
      aliases: ["check"],
      summary: "Look up one bounty.",
      argStyle: "positional",
      literalTokens: ["bountii"],
      args: [{ name: "bounty_id", type: "subject_id", required: true }],
      example: "@bountydesk status 12",
    },
    {
      name: "cancel",
      aliases: ["withdraw"],
      summary: "Cancel a bounty you opened.",
      // Destructive, and "cancel" is a plausible sentence opener — so an
      // ambiguous resolution of this verb must be confirmed, not acted on.
      consequential: true,
      argStyle: "pipe",
      args: [
        { name: "bounty_id", type: "subject_id", required: true },
        { name: "reason", type: "text", required: false, maxLength: 200 },
      ],
      example: "@bountydesk cancel | 12 | requirements changed",
    },
    {
      // Moves money, so the site requires a key_bound caller: a bare mention
      // can open a bounty but can never fund one.
      name: "fund",
      summary: "Record escrow funding for a bounty.",
      consequential: true,
      argStyle: "positional",
      args: [{ name: "bounty_id", type: "subject_id", required: true }],
      example: "@bountydesk fund 12",
    },
    {
      name: "help",
      aliases: ["commands", "usage"],
      summary: "List what this desk understands.",
      args: [],
      example: "@bountydesk help",
    },
  ],
};
