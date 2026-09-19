import { Suspense } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { DecisionClient, DecisionView } from "@/components/decision-client";
import { ExpiredSession, LoadingBlock } from "@/components/session-states";
import { loadSubjectForMuse } from "@/platform/dashboard";
import { prepareReleaseTx } from "@/platform/decisions";
import { PlatformError } from "@/platform/errors";
import { COOKIE_NAME, loadSession, sessionView } from "@/platform/session";

export const dynamic = "force-dynamic";

export default async function DecidePage({
  params,
  searchParams,
}: {
  params: Promise<{ subjectId: string }>;
  searchParams: Promise<{ action?: string }>;
}) {
  const { subjectId } = await params;
  const { action = null } = await searchParams;
  const token = (await cookies()).get(COOKIE_NAME)?.value ?? null;

  if (token) {
    try {
      const session = await loadSession(token);
      const item = await loadSubjectForMuse(session.actor.id, subjectId);
      const latest = item.bounty?.submissions?.[0] ?? null;
      const prepared_tx =
        action === "agree" && item.bounty
          ? prepareReleaseTx({
              subjectId,
              submissionId: latest?.id ?? null,
              payeeMuseId: latest?.worker ?? null,
              amount: {
                currency: item.bounty.escrow.balance.currency,
                minor: item.bounty.escrow.balance.minor,
                display: item.bounty.escrow.balance.display,
              },
            })
          : null;
      return (
        <DecisionView
          subjectId={subjectId}
          action={action}
          data={{
            session: sessionView(session),
            item,
            prepared_tx,
          }}
        />
      );
    } catch (error) {
      if (error instanceof PlatformError && error.code === "not_found") {
        notFound();
      }
      if (
        error instanceof PlatformError &&
        (error.code === "session_expired" || error.code === "unauthorized")
      ) {
        return <ExpiredSession reason={error.message} />;
      }
    }
  }

  return (
    <Suspense fallback={<LoadingBlock label="Loading decision" />}>
      <DecisionClient subjectId={subjectId} />
    </Suspense>
  );
}
