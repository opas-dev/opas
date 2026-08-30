// ABOUTME: Caps public support-handoff attempts per requester and warm application process.
// ABOUTME: Keeps only salted one-minute Cloudflare requester keys in ephemeral memory.
export const handoffRequestWindowMilliseconds = 60_000;
export const handoffRequestProcessLimit = 20;
export const handoffRequestRequesterLimit = 2;

export type HandoffRequestAllowance =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; retryAfterSeconds: number }>;

type RequesterKey = (request: Request) => Promise<string | null>;

type HandoffRequestWindow = {
  count: number;
  id: number;
  requesterCounts: Map<string, number>;
};

const requesterSalt = crypto.getRandomValues(new Uint8Array(32));
const textEncoder = new TextEncoder();

function trustedNetworkAddress(request: Request, deployment: string | undefined) {
  if (deployment !== "d1") return null;
  const address = request.headers.get("cf-connecting-ip")?.trim().slice(0, 256);
  return address || null;
}

export async function anonymousHandoffRequesterKey(
  request: Request,
  deployment: string | undefined = process.env.OPAS_DATABASE_DRIVER,
) {
  const trustedAddress = trustedNetworkAddress(request, deployment);
  if (trustedAddress === null) return null;
  const address = textEncoder.encode(trustedAddress);
  const input = new Uint8Array(requesterSalt.byteLength + address.byteLength);
  input.set(requesterSalt);
  input.set(address, requesterSalt.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function retryAfterSeconds(windowId: number, timestamp: number) {
  const nextWindowAt = (windowId + 1) * handoffRequestWindowMilliseconds;
  return Math.max(1, Math.ceil((nextWindowAt - timestamp) / 1_000));
}

export function createHandoffRequestGate(requesterKey: RequesterKey) {
  const window: HandoffRequestWindow = {
    count: 0,
    id: -1,
    requesterCounts: new Map(),
  };

  return async (
    request: Request,
    timestamp = Date.now(),
  ): Promise<HandoffRequestAllowance> => {
    if (!Number.isFinite(timestamp)) {
      throw new RangeError("Support handoff gate timestamps must be finite");
    }
    const requester = await requesterKey(request);
    const requestedWindowId = Math.floor(
      timestamp / handoffRequestWindowMilliseconds,
    );
    if (requestedWindowId > window.id) {
      window.id = requestedWindowId;
      window.count = 0;
      window.requesterCounts.clear();
    }
    const activeWindowStartedAt = window.id * handoffRequestWindowMilliseconds;
    const retryAfter = retryAfterSeconds(
      window.id,
      Math.max(timestamp, activeWindowStartedAt),
    );
    const requesterCount =
      requester === null ? 0 : window.requesterCounts.get(requester) ?? 0;
    if (
      window.count >= handoffRequestProcessLimit ||
      (requester !== null && requesterCount >= handoffRequestRequesterLimit)
    ) {
      return Object.freeze({ accepted: false, retryAfterSeconds: retryAfter });
    }
    window.count += 1;
    if (requester !== null) {
      window.requesterCounts.set(requester, requesterCount + 1);
    }
    return Object.freeze({ accepted: true });
  };
}

export const consumeHandoffRequestAllowance = createHandoffRequestGate(
  anonymousHandoffRequesterKey,
);
