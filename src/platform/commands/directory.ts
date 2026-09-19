import { listJobs } from "../jobs";
import { listCommands, listModules } from "./registry";
import { addressFor, getTrigger, renderCommand } from "./trigger";

/** The machine-readable command directory — the same data the UI renders. */
export function commandDirectory() {
  return {
    object: "command_directory",
    trigger: getTrigger().style,
    families: listModules().map((module) => ({
      id: module.id,
      address: addressFor(module.id),
      museId: module.museId,
      title: module.title,
      description: module.description,
      trust: module.trust,
      maintainer: module.maintainer,
      defaultAction: module.defaultAction ?? null,
      aliases: module.aliases ?? [],
    })),
    commands: listCommands().map((command) => ({
      name: renderCommand(command.family, command.action),
      family: command.family,
      action: command.action,
      museId: command.museId,
      trust: command.trust,
      summary: command.summary,
      usage: command.usage,
      argStyle: command.argStyle,
      literalTokens: command.literalTokens ?? [],
      minAssurance: command.minAssurance,
      capabilities: command.capabilities,
      examples: command.examples ?? [],
      args: command.args.map((arg) => ({
        name: arg.name,
        type: arg.type,
        required: Boolean(arg.required),
        maxLen: arg.maxLen ?? 280,
        description: arg.description,
        values: arg.values ?? null,
        default: arg.default ?? null,
        example: arg.example ?? null,
      })),
    })),
    scheduledJobs: listJobs().map((job) => ({
      name: job.name,
      module: job.moduleId,
      schedule: job.schedule,
      summary: job.summary,
      capabilities: job.capabilities,
    })),
  };
}
