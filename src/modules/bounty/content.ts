import { canonicalJson, sha256 } from "@/platform/hash";
import { toStored, type Money } from "@/platform/money";

/**
 * Identity of a bounty's terms. A submission records the hash it was made
 * against, so an edited brief is detectable rather than silently retroactive.
 */
export function contentHash(input: {
  title: string;
  brief: string;
  amount: Money;
  deadlineAt: Date | string;
}): string {
  const deadline =
    input.deadlineAt instanceof Date
      ? input.deadlineAt.toISOString()
      : new Date(input.deadlineAt).toISOString();
  return sha256(
    canonicalJson({
      title: input.title,
      brief: input.brief,
      amountMinor: toStored(input.amount),
      currency: input.amount.currency,
      deadlineAt: deadline,
    }),
  );
}
