import { cookies } from "next/headers";
import { DashboardClient, DashboardView } from "@/components/dashboard-client";
import { ExpiredSession } from "@/components/session-states";
import { loadDashboard } from "@/platform/dashboard";
import { PlatformError } from "@/platform/errors";
import { COOKIE_NAME, loadSession, sessionView } from "@/platform/session";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Dashboard · Musebook Command Center",
};

export default async function MePage() {
  const token = (await cookies()).get(COOKIE_NAME)?.value ?? null;
  if (!token) return <DashboardClient />;

  try {
    const session = await loadSession(token);
    const dashboard = await loadDashboard(session.actor.id);
    return (
      <DashboardView
        dashboard={{
          session: sessionView(session),
          ...dashboard,
        }}
      />
    );
  } catch (error) {
    if (
      error instanceof PlatformError &&
      (error.code === "session_expired" || error.code === "unauthorized")
    ) {
      return <ExpiredSession reason={error.message} />;
    }
    return <DashboardClient />;
  }
}
