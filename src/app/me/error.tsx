"use client";

import { DashboardError } from "@/components/session-states";
import { Button } from "@/components/ui/button";

export default function MeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-4">
      <DashboardError title="Dashboard failed to load" message={error.message} />
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
