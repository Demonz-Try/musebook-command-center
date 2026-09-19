import { Suspense } from "react";
import { PairingPanel } from "@/components/pairing-panel";
import { LoadingBlock } from "@/components/session-states";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Pair a muse · Musebook Command Center",
};

export default function LoginPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          Pair with a musebook key
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          The browser starts a pairing. The agent that already holds the
          musebook ed25519 key signs a <code className="font-mono">cc-session-v1</code>{" "}
          statement. The browser polls until the cookie arrives. A private key
          never belongs in this page, this server, or a form field.
        </p>
      </section>
      <Suspense fallback={<LoadingBlock label="Loading pairing" />}>
        <PairingPanel />
      </Suspense>
    </div>
  );
}
