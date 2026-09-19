import { channelForPlace } from "./places.js";
import type { Logger } from "../runtime/logger.js";

/**
 * Optional WebSocket accelerator.
 *
 * Strictly a latency optimization. The stream has no replay, no resume offset
 * and no message ids, so anything emitted while disconnected is gone; its
 * excerpt is 140 characters, so it is never the payload; and it keys on place
 * slugs that do not cover every channel. If this class never connects, the
 * agent is still correct — just slower.
 */
export interface LiveEventHandlers {
  onPost: (input: { postId: number; channel: string | null; placeSlug: string | null }) => void;
  onDegraded?: (reason: string) => void;
}

export interface LiveClientOptions {
  url?: string;
  logger?: Logger;
  handlers: LiveEventHandlers;
  /** The site's own client uses 25s. */
  pingIntervalMs?: number;
  /** The site's own client falls back to polling after 3 failures. */
  maxConsecutiveFailures?: number;
  webSocketImpl?: typeof WebSocket;
}

const DEFAULT_URL = "wss://musebook.lol/api/v2/town/live";

export class LiveClient {
  private readonly url: string;
  private readonly logger?: Logger;
  private readonly handlers: LiveEventHandlers;
  private readonly pingIntervalMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly webSocketImpl: typeof WebSocket;
  private socket: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;

  constructor(options: LiveClientOptions) {
    this.url = options.url ?? DEFAULT_URL;
    this.logger = options.logger;
    this.handlers = options.handlers;
    this.pingIntervalMs = options.pingIntervalMs ?? 25_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.webSocketImpl = options.webSocketImpl ?? WebSocket;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.logger?.debug("connecting to town live stream", { url: this.url });

    let socket: WebSocket;
    try {
      socket = new this.webSocketImpl(this.url);
    } catch (cause) {
      this.scheduleReconnect(`could not open socket: ${String(cause)}`);
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.failures = 0;
      this.logger?.info("town live stream connected");
      this.pingTimer = setInterval(() => {
        try {
          socket.send("ping");
        } catch {
          /* the close handler will deal with it */
        }
      }, this.pingIntervalMs);
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      if (raw === "pong") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      this.handleEvent(parsed);
    });

    socket.addEventListener("error", () => {
      // The close handler always follows; reconnect logic lives there.
    });

    socket.addEventListener("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.socket = null;
      this.scheduleReconnect("stream closed");
    });
  }

  private handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const record = event as Record<string, unknown>;
    const type = record.type;
    if (type !== "post.created" && type !== "thread.created") return;

    const postId = typeof record.postId === "number" ? record.postId : undefined;
    const threadId = typeof record.threadId === "number" ? record.threadId : undefined;
    const id = postId ?? threadId;
    if (id === undefined) return;

    const placeSlug = typeof record.placeSlug === "string" ? record.placeSlug : null;
    this.handlers.onPost({ postId: id, channel: channelForPlace(placeSlug), placeSlug });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.failures += 1;
    if (this.failures >= this.maxConsecutiveFailures) {
      this.logger?.warn("town live stream keeps failing; polling continues alone", {
        failures: this.failures,
        reason,
      });
      this.handlers.onDegraded?.(reason);
    }
    const delay = Math.min(1000 * 2 ** this.failures, 30_000);
    this.logger?.debug("reconnecting to town live stream", { delay, reason });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
