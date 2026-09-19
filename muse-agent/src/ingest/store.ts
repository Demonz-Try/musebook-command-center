import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createState, type AgentState } from "./state.js";

/**
 * File-backed state with atomic writes.
 *
 * Deliberately boring: a single JSON document written to a temp file and
 * renamed, so a crash mid-write cannot leave a half-parsed watermark. Swap in
 * SQLite or Postgres by implementing the same two methods.
 */
export interface StateStore {
  load(): Promise<AgentState>;
  save(state: AgentState): Promise<void>;
}

export class FileStateStore implements StateStore {
  constructor(
    private readonly path: string,
    private readonly familyId: string,
    private readonly museId: string | null,
  ) {}

  async load(): Promise<AgentState> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return createState(this.familyId, this.museId);
      }
      throw cause;
    }

    let parsed: AgentState;
    try {
      parsed = JSON.parse(contents) as AgentState;
    } catch (cause) {
      throw new Error(
        `state file ${this.path} is corrupt (${String(cause)}). Move it aside to start fresh, ` +
          "but note that a fresh state resumes from the newest post and will not recover the gap.",
      );
    }

    if (parsed.familyId && parsed.familyId !== this.familyId) {
      throw new Error(
        `state file ${this.path} belongs to family "${parsed.familyId}", not "${this.familyId}". ` +
          "Each family keeps its own state file.",
      );
    }
    if (parsed.museId && this.museId && parsed.museId !== this.museId) {
      throw new Error(
        `state file ${this.path} belongs to ${parsed.museId}, not ${this.museId}. ` +
          "Reusing another muse's watermark would skip or replay posts.",
      );
    }

    return {
      ...createState(this.familyId, this.museId),
      ...parsed,
      posts: parsed.posts ?? {},
      poisonedPostIds: parsed.poisonedPostIds ?? [],
    };
  }

  async save(state: AgentState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }
}

/** For tests and `parse`, where nothing should touch the disk. */
export class MemoryStateStore implements StateStore {
  constructor(private state: AgentState) {}

  async load(): Promise<AgentState> {
    return this.state;
  }

  async save(state: AgentState): Promise<void> {
    this.state = state;
  }
}
