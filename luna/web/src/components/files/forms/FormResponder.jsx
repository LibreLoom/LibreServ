import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, CheckCircle2, Send } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CopyableValue from "@libreloom/ui/components/ui/CopyableValue.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { apiErrorMessage } from "../../../lib/api.js";
import { newEditToken } from "../../../lib/formDocument.js";
import { answerOptions, formatAnswer, isAnswered, typeInfo } from "./questionTypes.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // a year
const SWIPE_PX = 60;
const AUTO_ADVANCE_MS = 280;

// Screens: -2 = completed landing, -1 = intro, 0..n-1 = one question each,
// n = review, n+1 = done.
const COMPLETED = -2;
const INTRO = -1;

function cookieName(kind, token) {
  return `lunaform_${kind}_${token}`;
}

function readCookie(name) {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return "";
}

function writeCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${COOKIE_MAX_AGE}; path=/; samesite=lax`;
}

function storageName(token) {
  return `lunaform_responses_${token}`;
}

/**
 * Every response this device has sent to this form, oldest first:
 * `{id, edit_token?, at, answers}` — `edit_token` only exists when the form
 * allowed changes at send time. This is the source of truth for "answered";
 * the `done` cookie is only a second layer for the responseLimit gate.
 */
function readStoredResponses(token) {
  try {
    const raw = localStorage.getItem(storageName(token));
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (r) =>
          r &&
          typeof r === "object" &&
          typeof r.id === "string" &&
          r.answers &&
          typeof r.answers === "object",
      );
    }
  } catch {
    // private browsing etc — treat as fresh
  }
  return [];
}

/** Upsert one response record by id; returns the new array (null if storage failed). */
function saveStoredResponse(token, entry) {
  try {
    const next = readStoredResponses(token).filter((r) => r.id !== entry.id);
    next.push(entry);
    localStorage.setItem(storageName(token), JSON.stringify(next));
    return next;
  } catch {
    // private browsing etc — the copyable edit link still works without it
    return null;
  }
}

/** "Mar 3, 7:41 PM" for the picker, or a plain fallback for old records. */
function formatSentAt(at) {
  const when = new Date(at);
  return at && !Number.isNaN(when.getTime())
    ? when.toLocaleString()
    : "Sent earlier";
}

/** "Coming?: Yes" — the first answered question, so entries are tellable apart. */
function responsePreview(entry, questions) {
  for (const q of questions) {
    const value = entry.answers ? entry.answers[q.id] : undefined;
    if (isAnswered(q, value)) {
      return `${q.label || "Untitled question"}: ${formatAnswer(q, value)}`;
    }
  }
  return "No answers saved";
}

/**
 * The unauthenticated responder flow for a `respond` share link — one
 * question per screen, Typeform-style: Enter/click/swipe forward, back to
 * revisit, review before send, then a thank-you card with a copyable edit
 * link when the form allows changes.
 *
 * "One answer per person" and the returning-edit flow are device-cookie
 * reminders, not locks — they gate the friendly path only.
 *
 * @param {{
 *   token: string,
 *   form: { title?: string, description?: string, questions?: object[], settings?: object },
 *   sharePassword?: string,
 * }} props
 */
export default function FormResponder({ token, form, sharePassword = "" }) {
  const [searchParams] = useSearchParams();
  const questions = useMemo(
    () => (Array.isArray(form?.questions) ? form.questions : []),
    [form],
  );
  const settings = form?.settings || {};
  const collecting = settings.collecting !== false;
  const allowEdits = settings.allowEdits !== false;
  const limitOne = settings.responseLimit === "one";

  const [step, setStep] = useState(INTRO);
  const [answers, setAnswers] = useState({});
  const [editToken, setEditToken] = useState("");
  const [responseId, setResponseId] = useState("");
  const [isEdit, setIsEdit] = useState(false);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [checkingEdit, setCheckingEdit] = useState(false);
  const [editNotice, setEditNotice] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [shakeKey, setShakeKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  // Edit mode is one scrollable page of every question — not the stepped
  // first-run flow — so changes are quick to find.
  const [editing, setEditing] = useState(false);
  const [editErrors, setEditErrors] = useState({});
  // Every response this device has sent — drives the completed landing and
  // the which-one picker. Each carries its own edit secret.
  const [storedResponses, setStoredResponses] = useState(/** @type {object[]} */ ([]));
  const [picking, setPicking] = useState(false);
  const touchYRef = useRef(/** @type {number | null} */ (null));
  const autoAdvanceRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  const done = step === questions.length + 1;
  const review = step === questions.length;

  useEffect(() => () => {
    if (autoAdvanceRef.current) clearTimeout(autoAdvanceRef.current);
  }, []);

  // Boot: an ?edit= link wins, then stored answers land on the completed
  // screen, else the done cookie still flags the one-answer gate. All state
  // writes happen inside the async boundary — none synchronously in the
  // effect body.
  useEffect(() => {
    if (!collecting) return undefined;
    let cancelled = false;
    (async () => {
      const urlEdit = (searchParams.get("edit") || "").trim();
      const stored = readStoredResponses(token);
      setStoredResponses(stored);

      if (urlEdit && allowEdits) {
        // Fetch the earlier answers so they can be changed.
        setCheckingEdit(true);
        setEditToken(urlEdit);
        const headers = { Accept: "application/json" };
        if (sharePassword) headers["X-Share-Password"] = sharePassword;
        try {
          const res = await fetch(
            `/s/${encodeURIComponent(token)}/respond?edit_token=${encodeURIComponent(urlEdit)}`,
            { headers },
          );
          const data = await res.json().catch(() => null);
          if (cancelled) return;
          if (res.ok && data && typeof data === "object") {
            const fetched =
              data.answers && typeof data.answers === "object" ? data.answers : {};
            const id = typeof data.id === "string" ? data.id : "";
            setAnswers(fetched);
            setResponseId(id);
            setIsEdit(true);
            setEditing(true); // straight into the single-page edit view
            haptic("success");
            // First-class on this device too — it joins the picker list.
            if (id) {
              const next = saveStoredResponse(token, {
                id,
                edit_token: urlEdit,
                at: Date.now(),
                answers: fetched,
              });
              if (next) setStoredResponses(next);
            }
          } else {
            setEditNotice(
              (data && data.error) ||
                "We couldn't find answers for that edit link. You can fill the form in fresh.",
            );
            setEditToken("");
            setStep(INTRO);
          }
        } catch {
          if (!cancelled) {
            setEditNotice("We couldn't reach the Luna. Check your connection and try again.");
            setEditToken("");
          }
        } finally {
          if (!cancelled) setCheckingEdit(false);
        }
        return;
      }

      if (cancelled) return;
      if (stored.length > 0) {
        // This device has sent answers before — land on the completed state,
        // not the fresh intro.
        setStep(COMPLETED);
        return;
      }

      if (limitOne && readCookie(cookieName("done", token))) {
        setAlreadyDone(true);
      }
    })();
    return () => { cancelled = true; };
  }, [token, sharePassword, collecting, allowEdits, limitOne, questions.length, searchParams]);

  // Keep the footer controls reachable while the on-screen keyboard is up:
  // ask the browser to shrink the layout viewport instead of overlapping.
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return undefined;
    const prev = meta.getAttribute("content") || "";
    if (prev.includes("interactive-widget")) return undefined;
    meta.setAttribute("content", `${prev}, interactive-widget=resizes-content`);
    return () => {
      meta.setAttribute("content", prev);
    };
  }, []);

  const currentQuestion = step >= 0 && step < questions.length ? questions[step] : null;

  // Stored responses that still carry a usable edit secret — the pickable
  // set for the edit picker.
  const editableResponses = storedResponses.filter(
    (r) => typeof r.edit_token === "string" && r.edit_token !== "",
  );

  function setAnswer(questionId, value, { autoAdvance = false } = {}) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    setFieldError("");
    if (autoAdvance) {
      if (autoAdvanceRef.current) clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = setTimeout(() => {
        haptic("light"); // step transition
        setStep((s) => Math.min(s + 1, questions.length));
      }, AUTO_ADVANCE_MS);
    }
  }

  function goBack() {
    haptic("light");
    setFieldError("");
    setStep((s) => Math.max(INTRO, s - 1));
  }

  function goForward() {
    if (currentQuestion) {
      if (
        currentQuestion.required &&
        !isAnswered(currentQuestion, answers[currentQuestion.id])
      ) {
        haptic("error");
        setFieldError("This one needs an answer before you continue.");
        setShakeKey((k) => k + 1);
        return;
      }
    }
    haptic("light");
    setFieldError("");
    setStep((s) => Math.min(s + 1, questions.length));
  }

  /** "Respond again" — a genuinely new response: fresh secret, no target id. */
  function respondAgain() {
    haptic("light");
    setAnswers({});
    setEditToken("");
    setResponseId("");
    setIsEdit(false);
    setEditErrors({});
    setPicking(false);
    setStep(INTRO);
  }

  /** Open the single-page edit view for one stored response. */
  function openEdit(entry) {
    haptic("selection");
    setEditToken(typeof entry.edit_token === "string" ? entry.edit_token : "");
    setResponseId(entry.id);
    setAnswers(entry.answers && typeof entry.answers === "object" ? entry.answers : {});
    setIsEdit(true);
    setEditErrors({});
    setPicking(false);
    setEditing(true);
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError("");
    const tokenToUse = allowEdits ? editToken || newEditToken() : "";
    try {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (sharePassword) headers["X-Share-Password"] = sharePassword;
      // Edit material only goes out when the form allows changes — the
      // server refuses a carried edit token or response id outright when
      // `allowEdits` is off.
      const body = { answers };
      if (allowEdits) {
        body.edit_token = tokenToUse;
        if (responseId) body.response_id = responseId;
      }
      const res = await fetch(`/s/${encodeURIComponent(token)}/respond`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          (data && data.error) || "Couldn't send your answers. Try again in a moment.",
        );
      }
      const id = typeof data?.id === "string" ? data.id : responseId;
      // The cookie only marks "done" for the responseLimit gate — the real
      // record of what this device sent lives in localStorage.
      writeCookie(cookieName("done", token), "1");
      if (id) {
        const entry = allowEdits
          ? {
              id,
              edit_token:
                data && typeof data.edit_token === "string"
                  ? data.edit_token
                  : tokenToUse,
              at: Date.now(),
              answers,
            }
          : { id, at: Date.now(), answers };
        const next = saveStoredResponse(token, entry);
        if (next) setStoredResponses(next);
      }
      setEditToken(
        allowEdits && data && typeof data.edit_token === "string"
          ? data.edit_token
          : tokenToUse,
      );
      if (id) setResponseId(id);
      setIsEdit(true);
      setEditing(false);
      setPicking(false);
      setStep(questions.length + 1);
      haptic("success");
    } catch (err) {
      haptic("error");
      setSubmitError(apiErrorMessage(err, "Couldn't send your answers. Try again in a moment."));
    } finally {
      setSubmitting(false);
    }
  }

  // Edit view: every answer on one page — clear a field's error as it is
  // fixed, then check required questions once on Save.
  function setEditAnswer(questionId, value) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    setEditErrors((prev) => {
      if (!prev[questionId]) return prev;
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  }

  function saveEdits() {
    const missing = {};
    for (const q of questions) {
      if (q.required && !isAnswered(q, answers[q.id])) {
        missing[q.id] = "This one needs an answer.";
      }
    }
    setEditErrors(missing);
    if (Object.keys(missing).length > 0) {
      haptic("error");
      return;
    }
    submit();
  }

  function onTouchStart(e) {
    touchYRef.current = e.touches?.[0]?.clientY ?? null;
  }

  function onTouchEnd(e) {
    const start = touchYRef.current;
    touchYRef.current = null;
    if (start == null || done || review || step === COMPLETED) return;
    const dy = (e.changedTouches?.[0]?.clientY ?? start) - start;
    if (dy < -SWIPE_PX) goForward();
    else if (dy > SWIPE_PX) goBack();
  }

  const editLink = `${window.location.origin}/s/${token}?edit=${editToken}`;

  // ---- state cards -------------------------------------------------------

  if (!collecting) {
    return (
      <StageCard
        title={form?.title || "This form"}
        subtitle="This form isn't collecting answers anymore."
      />
    );
  }

  if (alreadyDone) {
    return (
      <StageCard
        title="You've already answered this form"
        subtitle="This form takes one answer per person. If that wasn't you, the form owner can share a fresh link."
        action={
          <Button
            variant="accent"
            surface="secondary"
            onClick={() => {
              haptic("light");
              setAlreadyDone(false);
            }}
          >
            Answer anyway
          </Button>
        }
      />
    );
  }

  if (checkingEdit) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center" role="status" aria-label="Opening your answers">
        <div className="flex items-center gap-3 text-secondary">
          <p className="font-mono text-sm uppercase tracking-widest">Opening</p>
          <Spinner size="md" decorative />
        </div>
      </div>
    );
  }

  if (picking) {
    return (
      <ResponsePicker
        responses={editableResponses}
        questions={questions}
        onPick={openEdit}
        onBack={() => {
          haptic("light");
          setPicking(false);
        }}
      />
    );
  }

  if (editing) {
    return (
      <EditAllScreen
        title={form?.title || "Untitled form"}
        questions={questions}
        answers={answers}
        errors={editErrors}
        submitting={submitting}
        submitError={submitError}
        onAnswer={setEditAnswer}
        onSave={saveEdits}
        onCancel={() => {
          haptic("selection");
          setEditErrors({});
          setEditing(false);
        }}
      />
    );
  }

  // ---- flow ---------------------------------------------------------------

  const progress = questions.length === 0 ? 1 : Math.min(1, Math.max(0, step + 1) / (questions.length + 1));

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (review) submit();
        else if (!done) goForward();
      }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* progress */}
      <div className="h-1 w-full bg-secondary/20">
        <div
          className="h-full bg-accent motion-safe:transition-all motion-safe:duration-300"
          style={{ width: `${Math.round(progress * 100)}%` }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-label="Form progress"
        />
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {step === COMPLETED ? (
          <div className="w-full max-w-xl space-y-4 text-center">
            <CheckCircle2 size={ICON_SIZE.xl} className="mx-auto text-success" aria-hidden="true" />
            <h1 className="font-mono text-2xl text-secondary">
              {storedResponses.length === 1
                ? "You've answered this form"
                : `You've sent ${storedResponses.length} answers`}
            </h1>
            <p className="text-sm text-secondary">
              {limitOne
                ? "This form takes one answer per person."
                : "Change an answer you sent, or send another one."}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {allowEdits && editableResponses.length > 0 && (
                <Button
                  variant="accent"
                  surface="secondary"
                  size="lg"
                  onClick={() => {
                    if (editableResponses.length === 1) {
                      openEdit(editableResponses[0]);
                    } else {
                      haptic("selection");
                      setPicking(true);
                    }
                  }}
                >
                  {editableResponses.length === 1 ? "Edit Response" : "Edit Responses"}
                </Button>
              )}
              {!limitOne && (
                <Button
                  variant="ghost"
                  surface="secondary"
                  size="lg"
                  onClick={respondAgain}
                >
                  Respond again
                </Button>
              )}
            </div>
          </div>
        ) : step === INTRO ? (
          <div className="w-full max-w-xl space-y-4 text-center">
            {editNotice && <PageNotice variant="warning">{editNotice}</PageNotice>}
            <h1 className="font-mono text-2xl text-secondary">{form?.title || "Untitled form"}</h1>
            {form?.description && (
              <p className="whitespace-pre-wrap text-sm text-secondary">{form.description}</p>
            )}
            {questions.length === 0 ? (
              <p className="text-sm text-secondary">
                This form doesn&apos;t have any questions yet — check back later.
              </p>
            ) : (
              <>
                <p className="text-xs text-accent">
                  {questions.length === 1 ? "1 question" : `${questions.length} questions`} — press Enter or swipe up to move on.
                </p>
                <Button variant="accent" surface="secondary" size="lg" onClick={goForward}>
                  Start
                  <ArrowRight size={ICON_SIZE.sm} aria-hidden="true" />
                </Button>
              </>
            )}
          </div>
        ) : currentQuestion ? (
          <QuestionScreen
            key={`${currentQuestion.id}:${shakeKey}`}
            question={currentQuestion}
            index={step}
            count={questions.length}
            value={answers[currentQuestion.id]}
            error={fieldError}
            onAnswer={(value, opts) => setAnswer(currentQuestion.id, value, opts)}
          />
        ) : review ? (
          <div className="w-full max-w-xl space-y-4">
            <h1 className="font-mono text-2xl text-secondary">
              {isEdit ? "Change your answers" : "Look it over"}
            </h1>
            <p className="text-sm text-secondary">
              {isEdit
                ? "Tap any line to change it, then send again."
                : "Tap any line to go back and change it."}
            </p>
            <div className="space-y-2">
              {questions.map((q, i) => (
                <button
                  key={q.id}
                  type="button"
                  className="flex w-full items-start gap-3 rounded-large-element bg-primary text-secondary p-4 text-left hover:bg-secondary/10 motion-safe:transition-colors"
                  onClick={() => {
                    haptic("selection");
                    setStep(i);
                  }}
                >
                  <span className="font-mono text-xs text-accent pt-0.5">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-secondary">
                      {q.label || "Untitled question"}
                    </span>
                    <span className={cn("block truncate text-sm", isAnswered(q, answers[q.id]) ? "text-secondary" : "text-accent")}>
                      {isAnswered(q, answers[q.id]) ? formatAnswer(q, answers[q.id]) : "No answer yet"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {submitError && <PageNotice variant="error">{submitError}</PageNotice>}
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" surface="secondary" onClick={goBack}>
                <ArrowLeft size={ICON_SIZE.sm} aria-hidden="true" />
                Back
              </Button>
              <Button
                variant="accent"
                surface="secondary"
                type="submit"
                disabled={submitting}
              >
                {submitting ? "Sending…" : isEdit ? "Send changes" : "Send answers"}
                <Send size={ICON_SIZE.sm} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : done ? (
          <div className="w-full max-w-xl space-y-4 text-center">
            <CheckCircle2 size={ICON_SIZE.xl} className="mx-auto text-success" aria-hidden="true" />
            <h1 className="font-mono text-2xl text-secondary">Sent — thank you</h1>
            {allowEdits && (
              <div className="space-y-2">
                <p className="text-sm text-secondary">
                  Want to change your answers later? Keep this link — it&apos;s only for you.
                </p>
                <CopyableValue value={editLink} surface="secondary" />
                <div>
                  <Button
                    variant="ghost"
                    surface="secondary"
                    onClick={() => {
                      haptic("selection");
                      setEditing(true);
                    }}
                  >
                    Edit Response
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* back/forward chrome on question screens */}
      {currentQuestion && !done && (
        <div className="flex items-center justify-between gap-2 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <Button variant="ghost" surface="secondary" onClick={goBack}>
            <ArrowLeft size={ICON_SIZE.sm} aria-hidden="true" />
            Back
          </Button>
          <Button variant="accent" surface="secondary" type="submit">
            {step === questions.length - 1 ? "Review answers" : "Continue"}
            <ArrowRight size={ICON_SIZE.sm} aria-hidden="true" />
          </Button>
        </div>
      )}
    </form>
  );
}

FormResponder.propTypes = {
  token: PropTypes.string.isRequired,
  form: PropTypes.object.isRequired,
  sharePassword: PropTypes.string,
};

/**
 * Centered message card for closed/already-answered states.
 * @param {{ title: string, subtitle: string, action?: import("react").ReactNode }} props
 */
function StageCard({ title, subtitle, action }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <div className="w-full max-w-md space-y-3 rounded-large-element bg-secondary text-primary p-6 text-center">
        <h1 className="font-mono text-xl text-primary">{title}</h1>
        <p className="text-sm text-primary">{subtitle}</p>
        {action}
      </div>
    </div>
  );
}

StageCard.propTypes = {
  title: PropTypes.string.isRequired,
  subtitle: PropTypes.string.isRequired,
  action: PropTypes.node,
};

/**
 * One question per screen — the stepped first-run flow.
 */
function QuestionScreen({ question, index, count, value, error, onAnswer }) {
  return (
    <div className="w-full max-w-xl space-y-4 animate-fade-in">
      <p className="font-mono text-xs uppercase tracking-widest text-accent">
        {index + 1} of {count}
        {question.required ? " · required" : ""}
      </p>
      <h1 className="font-mono text-2xl text-secondary">{question.label || "Untitled question"}</h1>
      <QuestionField question={question} value={value} error={error} onAnswer={onAnswer} />
    </div>
  );
}

QuestionScreen.propTypes = {
  question: PropTypes.object.isRequired,
  index: PropTypes.number.isRequired,
  count: PropTypes.number.isRequired,
  value: PropTypes.any,
  error: PropTypes.string,
  onAnswer: PropTypes.func.isRequired,
};

/**
 * Every question on one scrollable page — used when a respondent changes
 * answers they already sent. Save checks required questions once and sends
 * the amended answers through the same respond endpoint with the edit
 * secret.
 * @param {{
 *   title: string,
 *   questions: object[],
 *   answers: Record<string, unknown>,
 *   errors: Record<string, string>,
 *   submitting: boolean,
 *   submitError: string,
 *   onAnswer: (questionId: string, value: unknown) => void,
 *   onSave: () => void,
 *   onCancel: () => void,
 * }} props
 */
function EditAllScreen({
  title,
  questions,
  answers,
  errors,
  submitting,
  submitError,
  onAnswer,
  onSave,
  onCancel,
}) {
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-xl space-y-6 pb-2">
          <header className="space-y-1">
            <h1 className="font-mono text-2xl text-secondary">Change your answers</h1>
            <p className="text-sm text-secondary">
              {title} — change what you need, then save at the bottom.
            </p>
          </header>
          {questions.map((q, i) => (
            <section key={q.id} className="space-y-2">
              <p className="font-mono text-xs uppercase tracking-widest text-accent">
                {i + 1} of {questions.length}
                {q.required ? " · required" : ""}
              </p>
              <h2 className="font-mono text-lg text-secondary">
                {q.label || "Untitled question"}
              </h2>
              <QuestionField
                question={q}
                value={answers[q.id]}
                error={errors[q.id]}
                onAnswer={(value) => onAnswer(q.id, value)}
              />
            </section>
          ))}
          {submitError && <PageNotice variant="error">{submitError}</PageNotice>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <Button variant="ghost" surface="secondary" onClick={onCancel}>
          <ArrowLeft size={ICON_SIZE.sm} aria-hidden="true" />
          Cancel
        </Button>
        <Button
          variant="accent"
          surface="secondary"
          type="submit"
          disabled={submitting}
        >
          {submitting ? "Saving…" : "Save changes"}
          <Send size={ICON_SIZE.sm} aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}

EditAllScreen.propTypes = {
  title: PropTypes.string.isRequired,
  questions: PropTypes.arrayOf(PropTypes.object).isRequired,
  answers: PropTypes.object.isRequired,
  errors: PropTypes.object.isRequired,
  submitting: PropTypes.bool.isRequired,
  submitError: PropTypes.string.isRequired,
  onAnswer: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};

/**
 * Which saved answer to change — shown when this device has sent several.
 * Each row shows when it was sent plus a preview of the first answered
 * question so the entries are easy to tell apart.
 * @param {{
 *   responses: object[],
 *   questions: object[],
 *   onPick: (entry: object) => void,
 *   onBack: () => void,
 * }} props
 */
function ResponsePicker({ responses, questions, onPick, onBack }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-xl space-y-4">
          <header className="space-y-1">
            <h1 className="font-mono text-2xl text-secondary">
              Which answer do you want to change?
            </h1>
            <p className="text-sm text-secondary">
              Pick one of the answers you&apos;ve sent.
            </p>
          </header>
          <div className="space-y-2">
            {responses.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                className="flex w-full items-start gap-3 rounded-large-element bg-primary text-secondary p-4 text-left hover:bg-secondary/10 motion-safe:transition-colors"
                onClick={() => onPick(entry)}
              >
                <span className="pt-0.5 font-mono text-xs text-accent">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-secondary">
                    {responsePreview(entry, questions)}
                  </span>
                  <span className="block text-xs text-accent">
                    {formatSentAt(entry.at)}
                  </span>
                </span>
                <ArrowRight
                  size={ICON_SIZE.sm}
                  className="mt-0.5 shrink-0 text-accent"
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <Button variant="ghost" surface="secondary" onClick={onBack}>
          <ArrowLeft size={ICON_SIZE.sm} aria-hidden="true" />
          Back
        </Button>
      </div>
    </div>
  );
}

ResponsePicker.propTypes = {
  responses: PropTypes.arrayOf(PropTypes.object).isRequired,
  questions: PropTypes.arrayOf(PropTypes.object).isRequired,
  onPick: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
};

/**
 * The answer control for one question. Choice/yes-no pick from pills; text
 * types get a single field; dropdown uses a native select; date uses a date
 * input. Unknown future types degrade to a short text field. Shared by the
 * stepped flow and the single-page edit view.
 */
function QuestionField({ question, value, error, onAnswer }) {
  const info = typeInfo(question.type);
  const options = answerOptions(question);
  const inputClass =
    "w-full rounded-pill border-2 border-secondary/30 bg-primary px-4 py-2 text-base text-secondary outline-none no-focus-outline focus:border-accent placeholder:text-accent";
  const picked = Array.isArray(value) ? value : value != null ? [String(value)] : [];

  // Keep the focused field (and the controls below it) clear of the
  // on-screen keyboard on small screens.
  function focusField(e) {
    e.currentTarget.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  return (
    <div className="space-y-3">
      {info.hint && <p className="text-sm text-accent">{info.hint}</p>}

      {question.type === "choice" || question.type === "yes_no" ? (
        <div className="flex flex-col gap-2">
          {options.map((option) => {
            const selected = question.type === "yes_no"
              ? value === (option === "Yes" ? "yes" : "no")
              : value === option;
            return (
              <button
                key={option}
                type="button"
                className={cn(
                  "rounded-pill border-2 px-4 py-3 text-left text-base motion-safe:transition-colors",
                  selected
                    ? "border-accent bg-accent text-primary"
                    : "border-secondary/30 bg-primary text-secondary hover:border-accent",
                )}
                aria-pressed={selected}
                onClick={() => {
                  haptic("selection");
                  onAnswer(
                    question.type === "yes_no" ? (option === "Yes" ? "yes" : "no") : option,
                    { autoAdvance: true },
                  );
                }}
              >
                {option}
              </button>
            );
          })}
        </div>
      ) : question.type === "multi_choice" ? (
        <div className="flex flex-col gap-2">
          {options.map((option) => {
            const selected = picked.includes(option);
            return (
              <button
                key={option}
                type="button"
                className={cn(
                  "rounded-pill border-2 px-4 py-3 text-left text-base motion-safe:transition-colors",
                  selected
                    ? "border-accent bg-accent text-primary"
                    : "border-secondary/30 bg-primary text-secondary hover:border-accent",
                )}
                aria-pressed={selected}
                onClick={() => {
                  haptic("selection");
                  const next = selected
                    ? picked.filter((p) => p !== option)
                    : [...picked, option];
                  onAnswer(next);
                }}
              >
                {option}
              </button>
            );
          })}
        </div>
      ) : question.type === "dropdown" ? (
        <select
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value)}
          aria-label={question.label || "Pick one"}
        >
          <option value="" disabled>
            Pick one…
          </option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : question.type === "date" ? (
        <input
          type="date"
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value)}
          aria-label={question.label || "Pick a day"}
        />
      ) : question.type === "long_text" ? (
        <textarea
          className={cn(inputClass, "rounded-large-element min-h-32 resize-y")}
          value={typeof value === "string" ? value : ""}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value)}
          placeholder="Type your answer"
          aria-label={question.label || "Your answer"}
        />
      ) : (
        <input
          type="text"
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value)}
          placeholder="Type your answer"
          aria-label={question.label || "Your answer"}
        />
      )}

      {error && <PageNotice variant="error">{error}</PageNotice>}
    </div>
  );
}

QuestionField.propTypes = {
  question: PropTypes.object.isRequired,
  value: PropTypes.any,
  error: PropTypes.string,
  onAnswer: PropTypes.func.isRequired,
};
