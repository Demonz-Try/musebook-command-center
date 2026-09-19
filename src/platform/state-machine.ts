import { PlatformError } from "./errors";

/**
 * A declarative state machine. Modules declare their states and the transitions
 * between them, so the legal moves are data that can be read (and rendered)
 * rather than conditionals scattered through handlers.
 */
export interface StateMachine<S extends string, T extends string> {
  readonly name: string;
  readonly initial: S;
  readonly terminal: readonly S[];
  readonly transitions: ReadonlyArray<{
    name: T;
    from: readonly S[];
    to: S;
    description: string;
  }>;
}

export function defineStateMachine<S extends string, T extends string>(
  machine: StateMachine<S, T>,
): StateMachine<S, T> {
  return machine;
}

export function canTransition<S extends string, T extends string>(
  machine: StateMachine<S, T>,
  from: S,
  transition: T,
): boolean {
  const edge = machine.transitions.find((t) => t.name === transition);
  return Boolean(edge && edge.from.includes(from));
}

export function assertTransition<S extends string, T extends string>(
  machine: StateMachine<S, T>,
  from: S,
  transition: T,
): S {
  const edge = machine.transitions.find((t) => t.name === transition);
  if (!edge) {
    throw new PlatformError(
      "validation",
      `${machine.name} has no transition named "${transition}"`,
    );
  }
  if (!edge.from.includes(from)) {
    throw new PlatformError(
      "invalid_state",
      `${machine.name}: "${transition}" is not legal from "${from}"`,
    );
  }
  return edge.to;
}

export function isTerminal<S extends string, T extends string>(
  machine: StateMachine<S, T>,
  state: S,
): boolean {
  return machine.terminal.includes(state);
}
