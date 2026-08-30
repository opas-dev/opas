// ABOUTME: Rate-limits public outcome updates before they can reach portable storage.
// ABOUTME: Retains only salted one-minute Cloudflare requester keys in process memory.
export const outcomeWriteWindowMilliseconds = 60_000;
export const outcomeWriteProcessLimit = 300;
export const outcomeWriteRequesterLimit = 20;

export type OutcomeWriteAllowance =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; retryAfterSeconds: number }>;

type RequesterKey = (request: Request) => Promise<string | null>;
type Window = { count: number; id: number; requesterCounts: Map<string, number> };

const requesterSalt = crypto.getRandomValues(new Uint8Array(32));
const encoder = new TextEncoder();

async function requesterKey(request: Request) {
  if (process.env.OPAS_DATABASE_DRIVER !== "d1") return null;
  const address = request.headers.get("cf-connecting-ip")?.trim().slice(0, 256);
  if (!address) return null;
  const encoded = encoder.encode(address);
  const input = new Uint8Array(requesterSalt.byteLength + encoded.byteLength);
  input.set(requesterSalt);
  input.set(encoded, requesterSalt.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createOutcomeWriteGate(key: RequesterKey = requesterKey) {
  const window: Window = { count: 0, id: -1, requesterCounts: new Map() };
  return async (
    request: Request,
    timestamp = Date.now(),
  ): Promise<OutcomeWriteAllowance> => {
    if (!Number.isFinite(timestamp)) {
      throw new RangeError("Outcome gate timestamps must be finite");
    }
    const requestedWindow = Math.floor(timestamp / outcomeWriteWindowMilliseconds);
    if (requestedWindow > window.id) {
      window.id = requestedWindow;
      window.count = 0;
      window.requesterCounts.clear();
    }
    const requester = await key(request);
    const requesterCount = requester ? window.requesterCounts.get(requester) ?? 0 : 0;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(
        ((window.id + 1) * outcomeWriteWindowMilliseconds -
          Math.max(timestamp, window.id * outcomeWriteWindowMilliseconds)) /
          1_000,
      ),
    );
    if (
      window.count >= outcomeWriteProcessLimit ||
      (requester !== null && requesterCount >= outcomeWriteRequesterLimit)
    ) {
      return Object.freeze({ accepted: false, retryAfterSeconds });
    }
    window.count += 1;
    if (requester !== null) {
      window.requesterCounts.set(requester, requesterCount + 1);
    }
    return Object.freeze({ accepted: true });
  };
}

export const consumeOutcomeWriteAllowance = createOutcomeWriteGate();
