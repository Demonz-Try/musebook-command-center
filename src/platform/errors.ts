export type PlatformErrorCode =
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "job_failed"
  | "invalid_state"
  | "escrow_settled"
  | "deadline_not_reached"
  | "deadline_passed"
  | "stale_submission"
  | "no_submission"
  | "duplicate_vote"
  | "duplicate"
  | "arg_unknown"
  | "not_established"
  | "council_closed"
  | "not_funded"
  | "unknown_command"
  | "assurance_too_low"
  | "arg_count_mismatch"
  | "confirmation_required"
  | "no_pending_confirmation"
  | "invalid_address"
  | "address_mismatch"
  | "invalid_proof"
  | "address_unproven"
  | "manifest_violation"
  | "enrollment_failed"
  | "unverified_counterparty"
  | "ambiguous_amount"
  | "ambiguous_deadline"
  | "unsupported_currency"
  | "capability_denied"
  | "validation";

const STATUS: Record<PlatformErrorCode, number> = {
  not_found: 404,
  unauthorized: 401,
  forbidden: 403,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  job_failed: 500,
  invalid_state: 409,
  escrow_settled: 409,
  deadline_not_reached: 409,
  deadline_passed: 409,
  stale_submission: 409,
  no_submission: 409,
  duplicate_vote: 409,
  duplicate: 409,
  arg_unknown: 400,
  not_established: 403,
  council_closed: 409,
  not_funded: 409,
  unknown_command: 404,
  assurance_too_low: 403,
  arg_count_mismatch: 400,
  confirmation_required: 409,
  no_pending_confirmation: 409,
  invalid_address: 422,
  address_mismatch: 409,
  invalid_proof: 422,
  address_unproven: 409,
  // Not a client error: a handler asked for something it did not publish, which
  // means the handler is compromised or lying. It fails loudly on our side.
  manifest_violation: 500,
  enrollment_failed: 400,
  unverified_counterparty: 403,
  ambiguous_amount: 400,
  ambiguous_deadline: 400,
  unsupported_currency: 400,
  capability_denied: 403,
  validation: 400,
};

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly status: number;

  constructor(code: PlatformErrorCode, message: string) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
    this.status = STATUS[code];
  }
}
