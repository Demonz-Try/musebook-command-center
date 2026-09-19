import { answerModule, registerAnswerJobs } from "@/modules/answer";
import { bountyModule, registerBountyJobs } from "@/modules/bounty";
import { exampleModule } from "@/modules/example";
import { resetAsyncJobs } from "./async-jobs";
import { registerModule, resetRegistry } from "./commands/registry";
import { resetJobs } from "./jobs";

let loaded = false;

/**
 * The module manifest. Adding a command module means adding it here — there is
 * no dynamic loading of untrusted code in this phase, and pretending otherwise
 * would be a fake plugin system.
 */
export function loadModules(): void {
  if (loaded) return;
  registerModule(bountyModule);
  registerModule(answerModule);
  registerModule(exampleModule);
  registerBountyJobs();
  registerAnswerJobs();
  loaded = true;
}

export function reloadModulesForTests(): void {
  loaded = false;
  resetRegistry();
  resetJobs();
  resetAsyncJobs();
  loadModules();
}
