/**
 * Which deploy this process is. Netlify sets `CONTEXT` on builds, functions and
 * edge functions; anything else — local `next dev`, `vitest` — is `dev`.
 */
export type DeployContext =
  | "production"
  | "deploy-preview"
  | "branch-deploy"
  | "dev";

const KNOWN: DeployContext[] = [
  "production",
  "deploy-preview",
  "branch-deploy",
  "dev",
];

export function deployContext(): DeployContext {
  const raw = process.env.CONTEXT?.trim();
  const known = KNOWN.find((c) => c === raw);
  return known ?? "dev";
}

export function isProduction(): boolean {
  return deployContext() === "production";
}

/**
 * A preview database is forked from production, so every row production held
 * at fork time — including the hashes of live API keys — exists in the preview
 * too. Keys are therefore bound to the context that issued them and refuse to
 * authenticate anywhere else.
 *
 * Without this, opening a pull request would quietly mint a second, less
 * guarded site that a production family token already opens. A preview is a
 * place to break things, which is exactly why production credentials must not
 * reach it.
 */
export function keysAreForkedFromProduction(): boolean {
  return deployContext() === "deploy-preview" || deployContext() === "branch-deploy";
}
