import { amendBounty, getBounty, SUBJECT_KIND } from "@/modules/bounty/escrow";
import { bountyView } from "@/modules/bounty/view";
import { mutationEndpoint, readEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return readEndpoint(request, async () => ({
    bounty: bountyView(await getBounty(id)),
  }));
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  return mutationEndpoint(
    request,
    "PATCH /api/bounties/[id]",
    async ({ actor, body }) => {
      await amendBounty(id, {
        actor,
        title: typeof body.title === "string" ? body.title : undefined,
        brief: typeof body.brief === "string" ? body.brief : undefined,
        deadlineAt:
          typeof body.deadlineAt === "string" ? body.deadlineAt : undefined,
      });
      return {
        body: { bounty: bountyView(await getBounty(id)) },
        receiptSubject: { kind: SUBJECT_KIND, id },
      };
    },
  );
}
