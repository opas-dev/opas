// ABOUTME: Runs saved evaluations and ephemeral answer checks from the administrator console.
// ABOUTME: Shows bounded safe results while keeping workspace identity and provider failures server-side.
"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import {
  qualityReviewImportSchema,
  safeQualitySourceUrl,
} from "@/quality/console";
import type { QualityManualReview } from "@/quality/console";
import type {
  QualityPlaygroundResult,
  QualityRetainedReplayResult,
} from "@/quality/runtime";

type QuestionSetOption = Readonly<{
  id: string;
  name: string;
  questionCount: number;
  version: number;
}>;

type RunResponse = Readonly<{ runId?: unknown }>;
type PlaygroundResponse = Readonly<{ result?: unknown }>;
type ReplayResponse = Readonly<{ result?: unknown }>;
type ImportResponse = Readonly<{
  questionSet?: Readonly<{
    id?: unknown;
    name?: unknown;
    questionCount?: unknown;
    version?: unknown;
  }>;
}>;
type ReviewResponse = Readonly<{
  review?: Readonly<{
    questionCount?: unknown;
    runId?: unknown;
  }>;
}>;

const maximumQuestionSetImportBytes = 256 * 1_024;

function safePlaygroundResult(value: unknown): QualityPlaygroundResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const result = value as Record<string, unknown>;
  const generation = result.generation;
  const validGeneration =
    generation === null ||
    (generation !== null &&
      typeof generation === "object" &&
      !Array.isArray(generation) &&
      typeof (generation as Record<string, unknown>).model === "string" &&
      typeof (generation as Record<string, unknown>).provider === "string");
  if (
    Object.keys(result).some(
      (key) =>
        ![
          "answer",
          "citations",
          "generation",
          "outcome",
          "preflightTrace",
          "question",
          "reason",
        ].includes(key),
    ) ||
    typeof result.question !== "string" ||
    (result.outcome !== "answer" &&
      result.outcome !== "abstain" &&
      result.outcome !== "unavailable") ||
    (result.answer !== null && typeof result.answer !== "string") ||
    (result.reason !== null && typeof result.reason !== "string") ||
    !validGeneration ||
    !Array.isArray(result.citations) ||
    result.citations.length > 5 ||
    result.citations.some((citation) => typeof citation !== "string") ||
    !Array.isArray(result.preflightTrace) ||
    result.preflightTrace.length > 5 ||
    result.preflightTrace.some((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return true;
      }
      const source = entry as Record<string, unknown>;
      const lineRange = source.sourceLineRange;
      return (
        Object.keys(source).some(
          (key) =>
            ![
              "articleContentHash",
              "articleId",
              "canonicalUrl",
              "contentHash",
              "excerpt",
              "headingPath",
              "indexGeneration",
              "mode",
              "ordinal",
              "score",
              "sourceId",
              "sourceLineRange",
              "title",
            ].includes(key),
        ) ||
        typeof source.articleContentHash !== "string" ||
        !/^[a-f\d]{64}$/u.test(source.articleContentHash) ||
        typeof source.articleId !== "string" ||
        typeof source.canonicalUrl !== "string" ||
        typeof source.contentHash !== "string" ||
        !/^[a-f\d]{64}$/u.test(source.contentHash) ||
        typeof source.excerpt !== "string" ||
        !Array.isArray(source.headingPath) ||
        source.headingPath.length > 10 ||
        source.headingPath.some((heading) => typeof heading !== "string") ||
        !Number.isSafeInteger(source.indexGeneration) ||
        (source.indexGeneration as number) < 1 ||
        (source.mode !== "hybrid" && source.mode !== "lexical" && source.mode !== "vector") ||
        !Number.isSafeInteger(source.ordinal) ||
        (source.ordinal as number) < 0 ||
        typeof source.score !== "number" ||
        !Number.isFinite(source.score) ||
        source.score < 0 ||
        typeof source.sourceId !== "string" ||
        lineRange === null ||
        typeof lineRange !== "object" ||
        Array.isArray(lineRange) ||
        Object.keys(lineRange).length !== 2 ||
        Object.keys(lineRange).some((key) => !["end", "start"].includes(key)) ||
        !Number.isSafeInteger((lineRange as Record<string, unknown>).start) ||
        !Number.isSafeInteger((lineRange as Record<string, unknown>).end) ||
        ((lineRange as { start: number }).start < 1) ||
        ((lineRange as { end: number }).end <
          (lineRange as { start: number }).start) ||
        typeof source.title !== "string"
      );
    })
  ) {
    return null;
  }
  return value as QualityPlaygroundResult;
}

function safeRetainedReplayResult(
  value: unknown,
): QualityRetainedReplayResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const result = value as Record<string, unknown>;
  const generation = result.generation;
  if (
    Object.keys(result).sort().join("\u0000") !==
      [
        "answer",
        "citations",
        "generation",
        "outcome",
        "question",
        "reason",
      ]
        .sort()
        .join("\u0000") ||
    (result.outcome !== "answer" && result.outcome !== "abstain") ||
    typeof result.question !== "string" ||
    result.question.length === 0 ||
    generation === null ||
    typeof generation !== "object" ||
    Array.isArray(generation) ||
    Object.keys(generation).sort().join("\u0000") !== "model\u0000provider" ||
    typeof (generation as Record<string, unknown>).model !== "string" ||
    typeof (generation as Record<string, unknown>).provider !== "string" ||
    !Array.isArray(result.citations) ||
    result.citations.length > 5
  ) {
    return null;
  }
  const citationIds = new Set<string>();
  for (const citation of result.citations) {
    if (
      citation === null ||
      typeof citation !== "object" ||
      Array.isArray(citation) ||
      Object.keys(citation).sort().join("\u0000") !== "id\u0000sourceId" ||
      typeof (citation as Record<string, unknown>).id !== "string" ||
      !/^C[1-5]$/u.test((citation as { id: string }).id) ||
      citationIds.has((citation as { id: string }).id) ||
      typeof (citation as Record<string, unknown>).sourceId !== "string"
    ) {
      return null;
    }
    citationIds.add((citation as { id: string }).id);
  }
  if (
    (result.outcome === "answer" &&
      (typeof result.answer !== "string" ||
        result.answer.length === 0 ||
        result.reason !== null ||
        result.citations.length === 0)) ||
    (result.outcome === "abstain" &&
      (result.answer !== null ||
        typeof result.reason !== "string" ||
        result.reason.length === 0 ||
        result.citations.length !== 0))
  ) {
    return null;
  }
  return value as QualityRetainedReplayResult;
}

async function safeJson(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

export function SavedQuestionControls({
  questionSets,
}: {
  questionSets: readonly QuestionSetOption[];
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(questionSetId: string) {
    setPendingId(questionSetId);
    setMessage(null);
    try {
      const response = await fetch("/admin/quality/run", {
        body: JSON.stringify({ questionSetId }),
        headers: { "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
      });
      const body = (await safeJson(response)) as RunResponse | null;
      if (!response.ok || typeof body?.runId !== "string") {
        setMessage(
          response.status === 422
            ? "This set is larger than the 100-question console limit. Split it before running."
            : response.status === 409
              ? "Publish and index content before running this set."
              : "The evaluation could not run. Try again after checking provider and index health.",
        );
        return;
      }
      router.push(`/admin/quality?run=${encodeURIComponent(body.runId)}`);
    } catch {
      setMessage("The evaluation could not run. Check the connection and try again.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div>
      <ul className="m-0 list-none divide-y divide-border border-y border-border p-0">
        {questionSets.map((questionSet) => (
          <li
            key={questionSet.id}
            className="flex flex-wrap items-center justify-between gap-4 py-4"
          >
            <div>
              <p className="m-0 font-semibold">{questionSet.name}</p>
              <p className="mb-0 mt-1 text-sm text-muted">
                Version {questionSet.version} · {questionSet.questionCount}{" "}
                {questionSet.questionCount === 1 ? "question" : "questions"}
              </p>
            </div>
            <button
              type="button"
              disabled={pendingId !== null}
              onClick={() => run(questionSet.id)}
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pendingId === questionSet.id ? "Running…" : "Run set"}
            </button>
          </li>
        ))}
      </ul>
      <p className="mb-0 mt-3 min-h-6 text-sm text-danger" aria-live="polite">
        {message}
      </p>
    </div>
  );
}

export function SavedQuestionImport() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [successful, setSuccessful] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!file) return;
    if (file.size > maximumQuestionSetImportBytes) {
      setSuccessful(false);
      setMessage("The fixture exceeds the 256 KiB import limit.");
      return;
    }
    setPending(true);
    setSuccessful(false);
    setMessage(null);
    try {
      const response = await fetch("/admin/quality/import", {
        body: file,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
      });
      const body = (await safeJson(response)) as ImportResponse | null;
      const questionSet = body?.questionSet;
      if (
        !response.ok ||
        typeof questionSet?.id !== "string" ||
        typeof questionSet.name !== "string" ||
        !Number.isSafeInteger(questionSet.questionCount) ||
        !Number.isSafeInteger(questionSet.version)
      ) {
        setMessage(
          response.status === 413
            ? "The fixture exceeds the 256 KiB import limit."
            : response.status === 409
              ? "A question set with this ID already exists. Import a new version with a new ID."
              : response.status === 422
                ? "One or more accepted source IDs and hashes do not match published indexed content."
                : "The fixture is malformed. Check its schema, question classes, outcomes, and hashes.",
        );
        return;
      }
      setSuccessful(true);
      setMessage(
        `Imported ${questionSet.name} version ${questionSet.version} with ${questionSet.questionCount} ${questionSet.questionCount === 1 ? "question" : "questions"}.`,
      );
      setFile(null);
      form.reset();
      router.refresh();
    } catch {
      setMessage("The question set could not be imported. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 max-w-3xl border-b border-border pb-6">
      <label htmlFor="quality-question-set-file" className="block text-sm font-semibold">
        Import a versioned question set
      </label>
      <p id="quality-question-set-help" className="mb-0 mt-1 text-sm leading-6 text-muted">
        JSON using <code>opas.saved-question-set.v1</code>, up to 256 KiB and 100 questions.
        Accepted source IDs must include their current published content hashes. The active
        workspace is assigned by the server.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          id="quality-question-set-file"
          type="file"
          accept="application/json,.json"
          aria-describedby="quality-question-set-help"
          required
          disabled={pending}
          onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
          className="block min-h-11 max-w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground file:mr-3 file:rounded file:border-0 file:bg-surface-strong file:px-3 file:py-1 file:font-semibold"
        />
        <button
          type="submit"
          disabled={pending || file === null}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Importing…" : "Import set"}
        </button>
      </div>
      <p
        className={`mb-0 mt-3 min-h-6 text-sm ${successful ? "text-success" : "text-danger"}`}
        aria-live="polite"
      >
        {message}
      </p>
    </form>
  );
}

type BinaryScore = "" | "no" | "yes";

function binaryScore(value: boolean | undefined): BinaryScore {
  return value === undefined ? "" : value ? "yes" : "no";
}

export function EvaluationReview({
  claims,
  manualReview,
  questionId,
  runId,
}: {
  claims: readonly Readonly<{ markdown: string; ordinal: number }>[];
  manualReview: QualityManualReview | null;
  questionId: string;
  runId: string;
}) {
  const router = useRouter();
  const [grounded, setGrounded] = useState<BinaryScore>(
    binaryScore(manualReview?.grounded),
  );
  const [materiallyCorrect, setMateriallyCorrect] = useState<BinaryScore>(
    binaryScore(manualReview?.materiallyCorrect),
  );
  const [claimScores, setClaimScores] = useState(() =>
    claims.map(({ markdown, ordinal }, index) => ({
      citationCovered: binaryScore(
        manualReview?.claims[index]?.citationCovered,
      ),
      entailed: binaryScore(manualReview?.claims[index]?.entailed),
      markdown,
      ordinal,
    })),
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !grounded ||
      !materiallyCorrect ||
      claimScores.some(({ citationCovered, entailed }) =>
        !citationCovered || !entailed
      )
    ) {
      setMessage("Score the answer and every material claim before saving.");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/admin/quality/review", {
        body: JSON.stringify({
          questions: [
            {
              claims: claimScores.map(
                ({ citationCovered, entailed, ordinal }) => ({
                  citationCovered: citationCovered === "yes",
                  entailed: entailed === "yes",
                  ordinal,
                }),
              ),
              grounded: grounded === "yes",
              id: questionId,
              materiallyCorrect: materiallyCorrect === "yes",
            },
          ],
          runId,
          schema: qualityReviewImportSchema,
        }),
        headers: { "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
      });
      const body = (await safeJson(response)) as ReviewResponse | null;
      if (
        !response.ok ||
        body?.review?.runId !== runId ||
        body.review.questionCount !== 1
      ) {
        setMessage(
          response.status === 404
            ? "This evaluation run is no longer available."
            : response.status === 409
              ? "This run is not a completed v3 evaluation."
              : "The review could not be saved. Check every score and retry.",
        );
        return;
      }
      setMessage("Manual review saved.");
      router.refresh();
    } catch {
      setMessage("The review could not be saved. Check the connection and retry.");
    } finally {
      setPending(false);
    }
  }

  function updateClaim(
    index: number,
    key: "citationCovered" | "entailed",
    value: BinaryScore,
  ) {
    setClaimScores((current) =>
      current.map((claim, claimIndex) =>
        claimIndex === index ? { ...claim, [key]: value } : claim,
      ),
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 border-t border-border pt-4">
      <fieldset disabled={pending} className="m-0 border-0 p-0">
        <legend className="text-xs font-semibold text-foreground">
          Human scoring
        </legend>
        <p className="mb-0 mt-1 text-xs leading-5 text-muted">
          Judge the answer against the displayed retained evidence. Provenance alone does not
          prove factual support.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold">
            Grounded
            <select
              required
              value={grounded}
              onChange={(event) => setGrounded(event.currentTarget.value as BinaryScore)}
              className="mt-1 block min-h-10 w-full rounded-md border border-border bg-surface px-2 text-sm"
            >
              <option value="">Select</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label className="text-xs font-semibold">
            Materially correct
            <select
              required
              value={materiallyCorrect}
              onChange={(event) =>
                setMateriallyCorrect(event.currentTarget.value as BinaryScore)
              }
              className="mt-1 block min-h-10 w-full rounded-md border border-border bg-surface px-2 text-sm"
            >
              <option value="">Select</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        </div>
        <ol className="m-0 mt-3 list-none space-y-3 p-0">
          {claimScores.map((claim, index) => (
            <li key={claim.ordinal} className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
              <p className="m-0 whitespace-pre-wrap text-xs leading-5 text-muted sm:col-span-2">
                Claim {claim.ordinal + 1}: {claim.markdown}
              </p>
              <label className="text-xs font-semibold">
                Claim {claim.ordinal + 1} entailed
                <select
                  required
                  value={claim.entailed}
                  onChange={(event) =>
                    updateClaim(index, "entailed", event.currentTarget.value as BinaryScore)
                  }
                  className="mt-1 block min-h-10 w-full rounded-md border border-border bg-surface px-2 text-sm"
                >
                  <option value="">Select</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
              <label className="text-xs font-semibold">
                Claim {claim.ordinal + 1} citation-covered
                <select
                  required
                  value={claim.citationCovered}
                  onChange={(event) =>
                    updateClaim(
                      index,
                      "citationCovered",
                      event.currentTarget.value as BinaryScore,
                    )
                  }
                  className="mt-1 block min-h-10 w-full rounded-md border border-border bg-surface px-2 text-sm"
                >
                  <option value="">Select</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
            </li>
          ))}
        </ol>
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Saving…" : manualReview ? "Update review" : "Save review"}
        </button>
        <p className="m-0 min-h-5 text-xs text-muted" aria-live="polite">
          {message}
        </p>
      </div>
    </form>
  );
}

export function RetainedEvidenceReplay({
  conversationId,
}: {
  conversationId: string;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<QualityRetainedReplayResult | null>(null);

  async function reproduce() {
    setPending(true);
    setMessage(null);
    setResult(null);
    try {
      const response = await fetch("/admin/quality/replay", {
        body: JSON.stringify({ conversationId }),
        headers: { "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
      });
      const body = (await safeJson(response)) as ReplayResponse | null;
      const parsed = safeRetainedReplayResult(body?.result);
      if (!response.ok || !parsed) {
        setMessage(
          response.status === 404
            ? "This conversation is no longer available within the retention window."
            : response.status === 409
              ? "The retained redacted question or evidence is insufficient for a safe reproduction."
              : response.status === 429
                ? "Reproduction is at its one-minute limit. Wait briefly and retry."
                : "The diagnostic reproduction is unavailable. Check generation configuration and retry.",
        );
        return;
      }
      setResult(parsed);
    } catch {
      setMessage("The diagnostic reproduction could not run. Check the connection and retry.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-8 border-t border-border pt-6">
      <h4 className="m-0 text-base font-semibold">Diagnostic reproduction</h4>
      <p className="mb-0 mt-2 max-w-3xl text-sm leading-6 text-muted">
        This calls the configured provider with only the retained redacted excerpts shown above,
        never queries the current knowledge index, and does not save the reproduction. Redaction
        and retention byte limits mean this is not a byte-identical replay of the original prompt.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={reproduce}
        className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Reproducing…" : "Reproduce from retained evidence"}
      </button>
      <p className="mb-0 mt-3 min-h-6 text-sm text-danger" aria-live="polite">
        {message}
      </p>

      {result ? (
        <div className="mt-4 border-y border-border py-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-1 text-xs font-semibold ${
                result.outcome === "answer"
                  ? "bg-success text-success-foreground"
                  : "bg-surface-strong text-muted"
              }`}
            >
              {result.outcome === "answer" ? "Answered" : "Abstained"}
            </span>
            <span className="text-xs text-muted">
              {result.generation.provider} · {result.generation.model}
            </span>
          </div>
          {result.answer ? (
            <p className="mb-0 mt-4 max-w-3xl whitespace-pre-wrap text-sm leading-7">
              {result.answer}
            </p>
          ) : (
            <p className="mb-0 mt-4 text-sm text-muted">
              No answer was generated{result.reason ? ` (${result.reason})` : ""}.
            </p>
          )}
          {result.citations.length > 0 ? (
            <p className="mb-0 mt-3 text-xs text-muted">
              Retained citations: {result.citations
                .map(({ id, sourceId }) => `${id} → ${sourceId}`)
                .join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function QualityPlayground() {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<QualityPlaygroundResult | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setResult(null);
    try {
      const response = await fetch("/admin/quality/playground", {
        body: JSON.stringify({ question }),
        headers: { "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
      });
      const body = (await safeJson(response)) as PlaygroundResponse | null;
      const parsed = safePlaygroundResult(body?.result);
      if (!response.ok || !parsed) {
        setMessage(
          response.status === 429
            ? "The playground is at its one-minute limit. Wait briefly and retry."
            : "The test could not run. Check answer and index configuration, then retry.",
        );
        return;
      }
      setResult(parsed);
    } catch {
      setMessage("The test could not run. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="max-w-3xl">
        <label htmlFor="quality-playground-question" className="block text-sm font-semibold">
          Ask the published knowledge base
        </label>
        <textarea
          id="quality-playground-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={200}
          required
          rows={3}
          className="mt-2 block w-full resize-y rounded-md border border-border bg-surface px-3 py-3 text-base leading-6 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          placeholder="How do I configure my workspace?"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending || question.trim().length === 0}
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Testing…" : "Test answer"}
          </button>
          <span className="text-sm text-muted">
            Ephemeral. This question and answer are not saved by the playground.
          </span>
        </div>
      </form>

      <p className="mb-0 mt-3 min-h-6 text-sm text-danger" aria-live="polite">
        {message}
      </p>

      {result ? (
        <div className="mt-6 border-t border-border pt-6" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-1 text-xs font-semibold ${
                result.outcome === "answer"
                  ? "bg-success text-success-foreground"
                  : "bg-surface-strong text-muted"
              }`}
            >
              {result.outcome === "answer"
                ? "Answered"
                : result.outcome === "abstain"
                  ? "Abstained"
                  : "Unavailable"}
            </span>
            {result.generation ? (
              <span className="text-xs text-muted">
                {result.generation.provider} · {result.generation.model}
              </span>
            ) : null}
          </div>
          {result.answer ? (
            <div className="mt-4 max-w-3xl whitespace-pre-wrap text-sm leading-7">
              {result.answer}
            </div>
          ) : (
            <p className="mb-0 mt-4 text-sm leading-6 text-muted">
              {result.outcome === "unavailable"
                ? "Generation is unavailable. The retrieval trace remains available below."
                : `No answer was generated${result.reason ? ` (${result.reason})` : ""}.`}
            </p>
          )}

          <h3 className="mb-0 mt-8 text-base font-semibold">Lexical preflight retrieval</h3>
          <p className="mb-0 mt-1 max-w-3xl text-xs leading-5 text-muted">
            These scores come from a separate lexical preview. The generated answer cited{" "}
            {result.citations.length > 0 ? result.citations.join(", ") : "no sources"}.
          </p>
          {result.preflightTrace.length > 0 ? (
            <ol className="m-0 mt-2 list-none divide-y divide-border border-y border-border p-0">
              {result.preflightTrace.map((source) => {
                const href = safeQualitySourceUrl(source.canonicalUrl);
                return (
                  <li key={source.sourceId} className="py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-primary"
                        >
                          {source.title}
                        </a>
                      ) : (
                        <span className="font-semibold">{source.title}</span>
                      )}
                      <span className="font-mono text-xs tabular-nums text-muted">
                        {source.score.toFixed(4)}
                      </span>
                    </div>
                    <p className="mb-0 mt-1 text-xs text-muted">
                      {source.sourceId} · generation {source.indexGeneration} · {source.mode}
                    </p>
                    <p className="mb-0 mt-2 whitespace-pre-wrap text-sm leading-6 text-muted">
                      Preflight excerpt: {source.excerpt}
                    </p>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="mb-0 mt-2 text-sm text-muted">No current evidence was retrieved.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
