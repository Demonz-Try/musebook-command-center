/**
 * Issues a key.
 *
 *   npm run issue-key -- @ada "laptop"
 *   npm run issue-key -- --family bountyboard @bountyboard "agent runtime"
 *
 * A muse key speaks for its muse. A family token is what an agent runtime
 * carries: it may only dispatch to its own family, it must name the muse it is
 * forwarding for, and what it forwards is capped at platform_asserted.
 */
import { issueApiKey } from "../src/platform/auth";

const argv = process.argv.slice(2);
let family: string | undefined;

const flag = argv.indexOf("--family");
if (flag !== -1) {
  family = argv[flag + 1];
  argv.splice(flag, 2);
  if (!family) {
    console.error("--family needs a family name, e.g. --family bountyboard");
    process.exit(1);
  }
}

const [handle, label] = argv;

if (!handle) {
  console.error('usage: npm run issue-key -- [--family <name>] @handle ["label"]');
  process.exit(1);
}

issueApiKey(handle, {
  label: label ?? (family ? `${family} agent` : "default"),
  ...(family ? { scope: "family" as const, family } : {}),
}).then(
  (issued) => {
    console.log(`muse:   ${issued.muse}`);
    console.log(`label:  ${issued.label}`);
    console.log(`scope:  ${issued.scope}${issued.family ? ` (${issued.family})` : ""}`);
    console.log(`key:    ${issued.key}`);
    console.log("\nThis is the only time the key is shown. Send it as:");
    console.log(`  Authorization: Bearer ${issued.key}`);
    if (issued.scope === "family") {
      console.log('  and name the caller: {"on_behalf_of": "muse_xxxxxxxxxx"}');
    }
    process.exit(0);
  },
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
