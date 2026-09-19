import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as enrollComplete } from "@/app/api/enroll/complete/route";
import { GET as enrollHelp, POST as enrollStart } from "@/app/api/enroll/start/route";
import { authenticate } from "@/platform/auth";
import {
  setIdentityResolver,
  type MusebookIdentity,
} from "@/platform/musebook/directory";
import { KEYLESS_MUSE, resetDatabase } from "./helpers";

const ENROLLING = "muse_signer01";
const YEAR = 365 * 24 * 60 * 60 * 1000;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
/** Musebook publishes bare 32-byte keys, so that is what we hand the resolver. */
const RAW_PUBLIC = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(12)
  .toString("base64");

const DIRECTORY: Record<string, MusebookIdentity> = {
  [ENROLLING]: {
    museId: ENROLLING,
    displayName: "Signer",
    publicKey: RAW_PUBLIC,
    idVerified: true,
    createdAt: new Date(Date.now() - YEAR),
  },
  [KEYLESS_MUSE]: {
    museId: KEYLESS_MUSE,
    displayName: "Signer",
    publicKey: null,
    idVerified: false,
    createdAt: new Date(Date.now() - YEAR),
  },
};

beforeEach(async () => {
  await resetDatabase();
  setIdentityResolver(async (id) => DIRECTORY[id] ?? null);
});

function post(path: string, body: unknown): Request {
  return new Request(`http://command-center.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signChallenge(signThis: string): string {
  return sign(null, Buffer.from(signThis, "utf8"), privateKey).toString("base64");
}

describe("enrollment is where key_bound is earned", () => {
  it("tells an unauthorized caller what to do, without a key", async () => {
    const body = await (await enrollHelp()).json();
    expect(body.object).toBe("enrollment_instructions");
    expect(body.steps.join(" ")).toContain("/api/enroll/complete");
  });

  it("turns a signed challenge into a key_bound API key", async () => {
    const challenge = await (
      await enrollStart(post("/api/enroll/start", { muse_id: ENROLLING }))
    ).json();

    expect(challenge.object).toBe("enrollment_challenge");
    expect(challenge.sign_this.startsWith("cc-enroll-v1\n")).toBe(true);

    const issued = await (
      await enrollComplete(
        post("/api/enroll/complete", {
          challenge_id: challenge.challengeId,
          signature: signChallenge(challenge.sign_this),
        }),
      )
    ).json();

    expect(issued.assurance).toBe("key_bound");
    expect(issued.bound_via).toBe("ed25519-challenge");

    const caller = await authenticate(
      new Request("http://command-center.test/api/bounties", {
        headers: { authorization: `Bearer ${issued.key}` },
      }),
    );
    expect(caller.actor.id).toBe(ENROLLING);
    expect(caller.assurance).toBe("key_bound");
  });

  it("refuses a signature that does not verify against the published key", async () => {
    const challenge = await (
      await enrollStart(post("/api/enroll/start", { muse_id: ENROLLING }))
    ).json();

    const other = generateKeyPairSync("ed25519").privateKey;
    const response = await enrollComplete(
      post("/api/enroll/complete", {
        challenge_id: challenge.challengeId,
        signature: sign(
          null,
          Buffer.from(challenge.sign_this, "utf8"),
          other,
        ).toString("base64"),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("enrollment_failed");
  });

  it("burns the challenge, so one signature mints at most one key", async () => {
    const challenge = await (
      await enrollStart(post("/api/enroll/start", { muse_id: ENROLLING }))
    ).json();
    const signature = signChallenge(challenge.sign_this);
    const body = { challenge_id: challenge.challengeId, signature };

    expect((await enrollComplete(post("/api/enroll/complete", body))).status).toBe(200);
    const replay = await enrollComplete(post("/api/enroll/complete", body));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.code).toBe("enrollment_failed");
  });

  it("cannot enrol a keyless identity, because there is nothing to challenge", async () => {
    const response = await enrollStart(
      post("/api/enroll/start", { muse_id: KEYLESS_MUSE }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("no public key");
  });

  it("enrols by muse id, never by display name", async () => {
    const response = await enrollStart(post("/api/enroll/start", { muse_id: "Signer" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("never by display name");
  });
});
