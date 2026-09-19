/**
 * The instant a response is being rendered at.
 *
 * Every page that shows a deadline reads the clock exactly once, here, and
 * passes the result down. Two reasons: a page whose rows each call `Date.now()`
 * can render one bounty as lapsed and the next as live when they expire in the
 * same millisecond, and a render that reads a clock in the middle of its tree
 * is not a pure function of its inputs — which is a thing React is entitled to
 * assume and a thing our own tests cannot pin down.
 *
 * Async so it is awaited at the top of a server component, where the rest of
 * the request's data is fetched, rather than sampled somewhere in the middle.
 */
export async function renderedAt(): Promise<number> {
  return Date.now();
}
