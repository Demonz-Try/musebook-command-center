import { beforeEach, describe, expect, it } from "vitest";
import { POST as commandsPost } from "@/app/api/commands/route";
import { POST as fundPost } from "@/app/api/fund/route";
import { issueApiKey } from "@/platform/auth";
import { OWNER, OWNER_WALLET, resetDatabase, WORKER } from "./helpers";

const BASE = "http://command-center.test";
const FORWARDED = "muse_wynjr";

let familyToken: string;

beforeEach(async () => {
  await resetDatabase();
  familyToken = (
    await issueApiKey("@bountyboard", { scope: "family", family: "bountyboard" })
  ).key;
});

function invoke(body: unknown, key: string, idempotencyKey = "mb_post:5001") {
  return new Request(`${BASE}/api/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

describe("the family token an agent runtime carries", () => {
  it("is issued against a family and is never key_bound", async () => {
    const issued = await issueApiKey("@answers", { scope: "family", family: "answers" });
    expect(issued.scope).toBe("family");
    expect(issued.family).toBe("answers");
    expect(issued.assurance).toBe("platform_asserted");

    await expect(
      issueApiKey("@answers", {
        scope: "family",
        family: "answers",
        assurance: "key_bound",
      }),
    ).rejects.toThrow(/cannot be key_bound/);
  });

  it("refuses to act as itself", async () => {
    const response = await commandsPost(
      invoke({ command: "@bountyboard list OPEN" }, familyToken),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toContain("on_behalf_of");
  });

  it("acts for the muse it names, and says so in the response", async () => {
    const response = await commandsPost(
      invoke(
        {
          command: `@bountyboard post Index the archive | Walk every channel and write it up | 40 USD | 7d | ${OWNER_WALLET}`,
          on_behalf_of: FORWARDED,
        },
        familyToken,
      ),
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.creator).toBe(FORWARDED);
    expect(body.caller.muse).toBe(FORWARDED);
    expect(body.caller.forwardedBy).toEqual({
      muse: "@bountyboard",
      family: "bountyboard",
    });
  });

  it("forwards at platform_asserted, so it can open a bounty and not fund one", async () => {
    const posted = await (
      await commandsPost(
        invoke(
          {
            command: `@bountyboard post Index the archive | Walk every channel and write it up | 40 USD | 7d | ${OWNER_WALLET}`,
            on_behalf_of: FORWARDED,
          },
          familyToken,
        ),
      )
    ).json();

    expect(posted.caller.assurance).toBe("platform_asserted");

    const funding = await fundPost(
      new Request(`${BASE}/api/fund`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${familyToken}`,
          "content-type": "application/json",
          "idempotency-key": "mb_post:5002",
        },
        body: JSON.stringify({
          bounty_id: posted.data.id,
          from: OWNER_WALLET,
          on_behalf_of: FORWARDED,
        }),
      }),
    );

    expect(funding.status).toBe(403);
    const error = await funding.json();
    expect(error.error.code).toBe("assurance_too_low");
    expect(error.error.message).toContain("/api/enroll/start");
  });

  it("cannot reach a family it was not issued for", async () => {
    const response = await commandsPost(
      invoke(
        { command: "@answers https://example.test/work.md", on_behalf_of: FORWARDED },
        familyToken,
      ),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toContain("scoped to the bountyboard");
  });

  it("leaves an ordinary muse key acting for itself", async () => {
    const own = (await issueApiKey(WORKER)).key;
    const body = await (
      await commandsPost(invoke({ command: "@bountyboard list OPEN" }, own))
    ).json();
    expect(body.caller.muse).toBe(WORKER);
    expect(body.caller.forwardedBy).toBeUndefined();
  });

  it("keys idempotency to the forwarded muse, not the token", async () => {
    const send = (key: string, on_behalf_of: string) =>
      commandsPost(
        invoke(
          { command: "@bountyboard list OPEN", ...(on_behalf_of ? { on_behalf_of } : {}) },
          key,
          "mb_post:7777",
        ),
      );

    const first = await (await send(familyToken, FORWARDED)).json();
    expect(first.idempotency.replayed).toBe(false);

    const replay = await (await send(familyToken, FORWARDED)).json();
    expect(replay.idempotency.replayed).toBe(true);

    // A different muse reusing the same post id is a different request, not a
    // replay of somebody else's.
    const other = await (await send(familyToken, "muse_fresh01")).json();
    expect(other.idempotency.replayed).toBe(false);
  });
});

describe("the owner's own key is unaffected", () => {
  it("still authenticates and still carries its own assurance", async () => {
    const issued = await issueApiKey(OWNER, { assurance: "key_bound", boundVia: "test" });
    const body = await (
      await commandsPost(invoke({ command: "@bountyboard list OPEN" }, issued.key))
    ).json();
    expect(body.caller.assurance).toBe("key_bound");
  });
});
