"use client";

import { DashboardError } from "@/components/session-states";
import { Button } from "@/components/ui/button";

export default function DecideError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-4">
      <DashboardError title="Decision page failed" message={error.message} />
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
