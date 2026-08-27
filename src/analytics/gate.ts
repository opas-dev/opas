// ABOUTME: Caps anonymous analytics database attempts by requester and running server process.
// ABOUTME: Keeps only salted one-minute network keys in memory and never persists request metadata.

export type ArticleEventKind = "feedback" | "view";

export const articleEventWindowMilliseconds = 60_000;
export const articleEventProcessLimits: Record<ArticleEventKind, number> = {
  feedback: 120,
  view: 600,
};
export const articleEventRequesterLimits: Record<ArticleEventKind, number> = {
  feedback: 5,
  view: 30,
};

export type ArticleEventAllowance =
  | { accepted: true }
  | { accepted: false; retryAfterSeconds: number };

type ArticleEventWindow = {
  id: number;
  count: number;
  requesterCounts: Map<string, number>;
};

type RequesterKey = (request: Request) => Promise<string | null>;

const requesterSalt = crypto.getRandomValues(new Uint8Array(32));
const textEncoder = new TextEncoder();

function trustedNetworkAddress(request: Request, deployment: string | undefined) {
  if (deployment !== "d1") {
    return null;
  }

  const address = request.headers.get("cf-connecting-ip")?.trim().slice(0, 256);
  return address || null;
}

export async function anonymousArticleEventRequesterKey(
  request: Request,
  deployment: string | undefined = process.env.OPAS_DATABASE_DRIVER,
) {
  const trustedAddress = trustedNetworkAddress(request, deployment);
  if (trustedAddress === null) {
    return null;
  }

  const address = textEncoder.encode(trustedAddress);
  const input = new Uint8Array(requesterSalt.byteLength + address.byteLength);
  input.set(requesterSalt);
  input.set(address, requesterSalt.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function retryAfterSeconds(windowId: number, timestamp: number) {
  const nextWindowAt = (windowId + 1) * articleEventWindowMilliseconds;
  return Math.max(1, Math.ceil((nextWindowAt - timestamp) / 1_000));
}

export function createArticleEventGate(requesterKey: RequesterKey) {
  const windows: Record<ArticleEventKind, ArticleEventWindow> = {
    feedback: { id: -1, count: 0, requesterCounts: new Map() },
    view: { id: -1, count: 0, requesterCounts: new Map() },
  };

  return async (
    kind: ArticleEventKind,
    request: Request,
    timestamp = Date.now(),
  ): Promise<ArticleEventAllowance> => {
    if (!Number.isFinite(timestamp)) {
      throw new RangeError("Article event gate timestamps must be finite.");
    }

    const requester = await requesterKey(request);
    const requestedWindowId = Math.floor(timestamp / articleEventWindowMilliseconds);
    const window = windows[kind];
    if (requestedWindowId > window.id) {
      window.id = requestedWindowId;
      window.count = 0;
      window.requesterCounts.clear();
    }

    const activeWindowStartedAt = window.id * articleEventWindowMilliseconds;
    const retryAfter = retryAfterSeconds(window.id, Math.max(timestamp, activeWindowStartedAt));
    const requesterCount = requester === null ? 0 : window.requesterCounts.get(requester) ?? 0;
    if (
      window.count >= articleEventProcessLimits[kind] ||
      (requester !== null && requesterCount >= articleEventRequesterLimits[kind])
    ) {
      return { accepted: false, retryAfterSeconds: retryAfter };
    }

    window.count += 1;
    if (requester !== null) {
      window.requesterCounts.set(requester, requesterCount + 1);
    }
    return { accepted: true };
  };
}

export const consumeArticleEventAllowance = createArticleEventGate(
  anonymousArticleEventRequesterKey,
);
