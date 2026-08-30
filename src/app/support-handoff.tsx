// ABOUTME: Renders the inline contact-support form used after cited answers and abstentions.
// ABOUTME: Sends only bounded conversation context with a stable same-origin idempotency key.
"use client";

import { useEffect, useRef, useState } from "react";

import type { HandoffSubmission } from "@/handoff/payload";

export type SupportHandoffContext = Omit<HandoffSubmission, "contact">;

type SupportContact = HandoffSubmission["contact"];

type SupportHandoffProps = Readonly<{
  conversationId: string;
  context: SupportHandoffContext;
  emphasized: boolean;
  requestKey: string;
}>;

type SendSupportHandoffOptions = Readonly<{
  fetch?: typeof fetch;
  signal?: AbortSignal;
}>;

type FormPhase = "error" | "idle" | "sending" | "success";

const maximumTranscriptMessages = 8;
const maximumTranscriptMessageUtf8Bytes = 2_048;
const maximumTranscriptUtf8Bytes = 8_192;
const maximumCitations = 20;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function truncateUtf8(value: string, maximumBytes: number) {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.slice(0, end)).trimEnd();
}

export function prepareSupportHandoffContext(
  context: SupportHandoffContext,
): SupportHandoffContext {
  const citations = [];
  const sourceIds = new Set<string>();
  for (const citation of context.citations) {
    if (sourceIds.has(citation.sourceId)) continue;
    sourceIds.add(citation.sourceId);
    citations.push(citation);
    if (citations.length === maximumCitations) break;
  }
  const transcript = [];
  let remaining = maximumTranscriptUtf8Bytes;
  for (const message of context.transcript
    .slice(-maximumTranscriptMessages)
    .reverse()) {
    if (remaining < 1) break;
    const content = truncateUtf8(
      message.content,
      Math.min(maximumTranscriptMessageUtf8Bytes, remaining),
    );
    if (!content) continue;
    transcript.unshift(Object.freeze({ content, role: message.role }));
    remaining -= encoder.encode(content).byteLength;
  }
  return Object.freeze({
    ...context,
    citations: Object.freeze(citations),
    transcript: Object.freeze(transcript),
  });
}

function responseStatus(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 1 &&
    keys[0] === "status" &&
    (record.status === "delivered" ||
      record.status === "duplicate" ||
      record.status === "pending")
    ? record.status
    : null;
}

async function responseJson(response: Response) {
  const contentType = response.headers.get("content-type");
  if (
    !contentType ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(contentType)
  ) {
    throw new Error("Support handoff request failed");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 1_024) {
    throw new Error("Support handoff request failed");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Support handoff request failed");
  }
}

export async function sendSupportHandoff(
  context: SupportHandoffContext,
  contact: SupportContact,
  idempotencyKey: string,
  options: SendSupportHandoffOptions = {},
) {
  const send = options.fetch ?? globalThis.fetch;
  if (typeof send !== "function") throw new Error("Support handoff request failed");
  let response: Response;
  try {
    const preparedContext = prepareSupportHandoffContext(context);
    response = await send("/api/handoff", {
      body: JSON.stringify({ ...preparedContext, contact }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "Idempotency-Key": idempotencyKey,
      },
      method: "POST",
      redirect: "error",
      signal: options.signal,
    });
  } catch {
    throw new Error("Support handoff request failed");
  }
  const status = responseStatus(await responseJson(response));
  if (!response.ok || !status || response.redirected) {
    throw new Error("Support handoff request failed");
  }
  return status;
}

function handoffCopy(outcome: SupportHandoffContext["outcome"]) {
  if (outcome === "abstained") {
    return "We couldn’t verify an answer from published content. Send this conversation to support for a human follow-up.";
  }
  if (outcome === "low-rated") {
    return "Send the question, answer, and published citations to support so they can follow up.";
  }
  return "Send this conversation and its published citations to support for a human follow-up.";
}

export function SupportHandoff({
  conversationId,
  context,
  emphasized,
  requestKey,
}: SupportHandoffProps) {
  return (
    <SupportHandoffForm
      key={requestKey}
      conversationId={conversationId}
      context={context}
      emphasized={emphasized}
      requestKey={requestKey}
    />
  );
}

function SupportHandoffForm({
  conversationId,
  context,
  emphasized,
  requestKey,
}: SupportHandoffProps) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<FormPhase>("idle");
  const activeRequest = useRef<AbortController | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const nameId = `support-name-${requestKey}`;
  const emailId = `support-email-${requestKey}`;
  const privacyId = `support-privacy-${requestKey}`;
  const statusId = `support-status-${requestKey}`;
  const open = emphasized || expanded;

  useEffect(
    () => () => {
      activeRequest.current?.abort();
    },
    [],
  );

  if (!open) {
    return (
      <section
        className="support-handoff"
        data-emphasized="false"
        data-open="false"
      >
        <button
          type="button"
          className="support-handoff-open"
          onClick={() => setExpanded(true)}
        >
          Contact support
        </button>
      </section>
    );
  }

  return (
    <section
      className="support-handoff"
      data-emphasized={String(emphasized)}
      data-open="true"
    >
      <div className="support-handoff-heading">
        <div>
          <h4>Contact support</h4>
          <p>{handoffCopy(context.outcome)}</p>
        </div>
        {!emphasized && phase !== "sending" && phase !== "success" ? (
          <button
            type="button"
            className="support-handoff-close"
            onClick={() => setExpanded(false)}
          >
            Close
          </button>
        ) : null}
      </div>

      {phase === "success" ? (
        <p className="support-handoff-success" id={statusId} role="status">
          Your request was accepted. Support can reply to the email you provided.
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (phase === "sending") return;
            const controller = new AbortController();
            activeRequest.current?.abort();
            activeRequest.current = controller;
            idempotencyKey.current ??= conversationId;
            setPhase("sending");
            void sendSupportHandoff(
              context,
              {
                email,
                ...(name.trim() ? { name } : {}),
              },
              idempotencyKey.current,
              { signal: controller.signal },
            )
              .then((status) => {
                if (activeRequest.current === controller) {
                  setPhase(status === "pending" ? "error" : "success");
                }
              })
              .catch(() => {
                if (activeRequest.current === controller) setPhase("error");
              })
              .finally(() => {
                if (activeRequest.current === controller) {
                  activeRequest.current = null;
                }
              });
          }}
        >
          <div className="support-handoff-fields">
            <label htmlFor={nameId}>
              Name <span>Optional</span>
              <input
                id={nameId}
                name="name"
                type="text"
                autoComplete="name"
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={phase !== "idle"}
              />
            </label>
            <label htmlFor={emailId}>
              Email
              <input
                id={emailId}
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-describedby={`${privacyId} ${statusId}`}
                disabled={phase !== "idle"}
                required
              />
            </label>
          </div>
          <p className="support-handoff-privacy" id={privacyId}>
            Your contact details are sent only with this support request.
          </p>
          <div className="support-handoff-submit">
            <button type="submit" disabled={phase === "sending"}>
              {phase === "sending"
                ? "Sending…"
                : phase === "error"
                  ? "Check delivery"
                  : "Send to support"}
            </button>
            <p
              id={statusId}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-error={phase === "error" ? "" : undefined}
            >
              {phase === "error"
                ? "We couldn’t confirm delivery. Your contact details stay fixed; check again with the same request and it will not send twice."
                : phase === "sending"
                  ? "Sending this conversation to support…"
                  : ""}
            </p>
          </div>
        </form>
      )}
    </section>
  );
}
