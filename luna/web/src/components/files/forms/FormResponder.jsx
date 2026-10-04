import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useSearchParams } from "react-router-dom";
import { AnimatePresence, MotionConfig, motion as Motion } from "motion/react";
import { ArrowLeft, CheckCircle2, Send, Upload, X } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import CopyableValue from "@libreloom/ui/components/ui/CopyableValue.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { apiErrorMessage, withCsrfHeaders } from "../../../lib/api.js";
import { newEditToken } from "../../../lib/formDocument.js";
import {
  FILE_ACCEPT,
  MAX_UPLOAD_BYTES,
  answerOptions,
  formatAnswer,
  isAllowedUploadName,
  isAnswered,
  isEmailAddress,
  visibleQuestions,
  DEFAULT_THANK_YOU,
} from "./questionTypes.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { shakeElement } from "@libreloom/ui/utils/shake.js";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // a year

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
 * The page someone fills in. It is the same page the editor is looking at:
 * title, description, every question that applies, then send. Skip rules
 * hide questions as answers change. There is no separate review step.
 *
 * "One answer per person" is a reminder stored in this browser, not a lock.
 *
 * @param {{
 *   token: string,
 *   form: { title?: string, description?: string, questions?: object[], settings?: object },
 *   sharePassword?: string,
 *   accepting?: boolean,
 *   full?: boolean,
 *   closedMessage?: string,
 * }} props
 */
export default function FormResponder(props) {
  return (
    <MotionConfig reducedMotion="user">
      <Responder {...props} />
    </MotionConfig>
  );
}

FormResponder.propTypes = {
  token: PropTypes.string.isRequired,
  form: PropTypes.object.isRequired,
  sharePassword: PropTypes.string,
  accepting: PropTypes.bool,
  full: PropTypes.bool,
  closedMessage: PropTypes.string,
};

function Responder({
  token,
  form,
  sharePassword = "",
  accepting = true,
  full = false,
  closedMessage = "",
}) {
  const [searchParams] = useSearchParams();
  const questions = useMemo(
    () => (Array.isArray(form?.questions) ? form.questions : []),
    [form],
  );
  const settings = form?.settings || {};
  const allowEdits = settings.allowEdits !== false;
  const limitOne = settings.responseLimit === "one";
  const thankYou = typeof settings.thankYou === "string" && settings.thankYou.trim()
    ? settings.thankYou.trim()
    : DEFAULT_THANK_YOU;

  const urlEdit = (searchParams.get("edit") || "").trim();
  const [storedResponses, setStoredResponses] = useState(() => readStoredResponses(token));
  const [remembered] = useState(
    () => readCookie(cookieName("done", token)) === "1" || storedResponses.length > 0,
  );
  const [answers, setAnswers] = useState(/** @type {Record<string, unknown>} */ ({}));
  const [editToken, setEditToken] = useState("");
  const [responseId, setResponseId] = useState("");
  const [isEdit, setIsEdit] = useState(false);
  /** Bumps whenever a different response is opened, so every field starts clean. */
  const [session, setSession] = useState(0);
  const [checkingEdit, setCheckingEdit] = useState(Boolean(urlEdit));
  const [editNotice, setEditNotice] = useState("");
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  /** "form" while filling in; "done" for the sent / answered-before screen. */
  const [stage, setStage] = useState(
    /** @type {"form" | "done" | "picking"} */ (!urlEdit && storedResponses.length > 0 ? "done" : !urlEdit && limitOne && remembered ? "done" : "form"),
  );
  /** True only for the screen right after a send — a return visit uses the older headings. */
  const [justSent, setJustSent] = useState(false);

  const shown = useMemo(
    () => visibleQuestions(questions, answers),
    [questions, answers],
  );

  useEffect(() => {
    if (!urlEdit) return undefined;
    let cancelled = false;
    const headers = { Accept: "application/json" };
    if (sharePassword) headers["X-Share-Password"] = sharePassword;
    fetch(
      `/s/${encodeURIComponent(token)}/respond?edit_token=${encodeURIComponent(urlEdit)}`,
      { headers },
    )
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(
            (data && data.error) || "We couldn't find answers for that edit link.",
          );
        }
        if (cancelled) return;
        setEditToken(urlEdit);
        setResponseId(typeof data?.id === "string" ? data.id : "");
        setAnswers(data && typeof data.answers === "object" && data.answers ? data.answers : {});
        setIsEdit(true);
        setSession((n) => n + 1);
        setStage("form");
      })
      .catch((err) => {
        if (cancelled) return;
        setEditNotice(apiErrorMessage(err, "We couldn't find answers for that edit link. You can fill the form in fresh."));
        setStage("form");
      })
      .finally(() => {
        if (!cancelled) setCheckingEdit(false);
      });
    return () => { cancelled = true; };
  }, [token, sharePassword, urlEdit]);

  const editableResponses = allowEdits
    ? storedResponses.filter((r) => typeof r.edit_token === "string" && r.edit_token !== "")
    : [];
  // A return visit still gets its edit link: the newest response this
  // browser can change, unless one was just sent or opened.
  const linkToken = editToken || editableResponses[editableResponses.length - 1]?.edit_token || "";
  const editLink = allowEdits && linkToken
    ? `${window.location.origin}/s/${token}?edit=${encodeURIComponent(linkToken)}`
    : "";

  function setAnswer(questionId, value) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    setErrors((prev) => {
      if (!prev[questionId]) return prev;
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  }

  function openEdit(entry) {
    setEditToken(typeof entry.edit_token === "string" ? entry.edit_token : "");
    setResponseId(entry.id);
    setAnswers(entry.answers && typeof entry.answers === "object" ? entry.answers : {});
    setIsEdit(true);
    setErrors({});
    setSubmitError("");
    setSession((n) => n + 1);
    setStage("form");
  }

  function respondAgain() {
    setAnswers({});
    setEditToken("");
    setResponseId("");
    setIsEdit(false);
    setErrors({});
    setSubmitError("");
    setJustSent(false);
    setSession((n) => n + 1);
    setStage("form");
  }

  function startEditing() {
    if (editableResponses.length === 1) openEdit(editableResponses[0]);
    else setStage("picking");
  }

  function answersToSend() {
    /** @type {Record<string, unknown>} */
    const body = {};
    for (const q of shown) {
      if (q.id in answers) body[q.id] = answers[q.id];
    }
    return body;
  }

  function validate() {
    /** @type {Record<string, string>} */
    const next = {};
    for (const q of shown) {
      const value = answers[q.id];
      if (q.required && !isAnswered(q, value)) {
        next[q.id] = "This one needs an answer.";
        continue;
      }
      if (q.type === "email" && isAnswered(q, value) && !isEmailAddress(value)) {
        next[q.id] = "That doesn't look like an email address. Check for an @ and a dot, like name@example.com.";
      }
      if (q.type === "number" && isAnswered(q, value)) {
        const n = Number(value);
        const min = q.config?.min;
        const max = q.config?.max;
        if (!Number.isFinite(n)) next[q.id] = "Enter a number.";
        else if (typeof min === "number" && n < min) next[q.id] = `Enter at least ${min}.`;
        else if (typeof max === "number" && n > max) next[q.id] = `Enter at most ${max}.`;
      }
    }
    return next;
  }

  async function submit() {
    if (submitting) return;
    const found = validate();
    if (Object.keys(found).length) {
      setErrors(found);
      const first = shown.find((q) => found[q.id]);
      if (first) {
        const el = document.getElementById(`q-${first.id}`);
        el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
        // shakeElement fires the error haptic with the shake.
        shakeElement(el);
      }
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    const tokenToUse = allowEdits ? editToken || newEditToken() : "";
    try {
      const headers = withCsrfHeaders("POST", {
        "Content-Type": "application/json",
        Accept: "application/json",
      });
      if (sharePassword) headers["X-Share-Password"] = sharePassword;
      const payload = { answers: answersToSend() };
      if (allowEdits) {
        payload.edit_token = tokenToUse;
        if (responseId) payload.response_id = responseId;
      }
      const res = await fetch(`/s/${encodeURIComponent(token)}/respond`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          (data && data.error) || "Luna couldn't send your answers. Check your connection and send again.",
        );
      }
      const id = typeof data?.id === "string" ? data.id : responseId;
      const issued = allowEdits && data && typeof data.edit_token === "string" ? data.edit_token : "";
      writeCookie(cookieName("done", token), "1");
      if (id) {
        const entry = allowEdits
          ? { id, edit_token: issued || tokenToUse, at: Date.now(), answers: answersToSend() }
          : { id, at: Date.now(), answers: answersToSend() };
        const next = saveStoredResponse(token, entry);
        if (next) setStoredResponses(next);
      }
      setEditToken(allowEdits ? issued || tokenToUse : "");
      if (id) setResponseId(id);
      setIsEdit(true);
      setJustSent(true);
      setStage("done");
      haptic("success");
    } catch (err) {
      haptic("error");
      setSubmitError(apiErrorMessage(err, "Luna couldn't send your answers. Check your connection and send again."));
    } finally {
      setSubmitting(false);
    }
  }

  if (!accepting) {
    return (
      <StageCard
        title={form?.title || "This form"}
        subtitle={closedMessage || "This form isn't collecting answers anymore."}
      />
    );
  }

  if (checkingEdit) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center" role="status" aria-label="Opening your answers">
        <div className="flex items-center gap-3 text-secondary">
          <p className="font-mono text-sm">Opening…</p>
          <Spinner size="md" decorative />
        </div>
      </div>
    );
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {stage === "picking" ? (
        <StageMotion key="picking">
          <ResponsePicker
            responses={editableResponses}
            questions={questions}
            onPick={openEdit}
            onBack={() => setStage("done")}
          />
        </StageMotion>
      ) : stage === "done" ? (
        <StageMotion key="done">
          <DoneScreen
            title={justSent
              ? thankYou
              : storedResponses.length > 1
                ? `You've sent ${storedResponses.length} responses to this form`
                : "You've answered this form"}
            editLink={editLink}
            canEdit={editableResponses.length > 0}
            editCount={editableResponses.length}
            canRespondAgain={!limitOne && !full}
            limitOne={limitOne}
            onEdit={startEditing}
            onRespondAgain={respondAgain}
          />
        </StageMotion>
      ) : full && !isEdit ? (
        <StageMotion key="full">
          <StageCard
            title={form?.title || "This form"}
            subtitle={closedMessage || "This form has all the answers it can take."}
          />
        </StageMotion>
      ) : (
        <StageMotion key={`form-${session}`} className="flex min-h-0 flex-1 flex-col">
          <form
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="mx-auto w-full max-w-2xl space-y-4 p-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:p-6">
              {editNotice && <PageNotice variant="warning">{editNotice}</PageNotice>}
              <div className="rounded-large-element surface-secondary p-5 space-y-2">
                {isEdit ? (
                  <p className="font-mono text-xs font-normal">
                    Changing your answers
                  </p>
                ) : null}
                <h1 className="font-mono text-xl font-normal text-primary">
                  {form?.title || "Untitled form"}
                </h1>
                {form?.description ? (
                  <p className="whitespace-pre-wrap text-sm text-primary">{form.description}</p>
                ) : null}
                {isEdit && (
                  <p className="text-sm text-primary">
                    Change what you need, then save. Your earlier answers are filled in.
                  </p>
                )}
              </div>

              {shown.length === 0 ? (
                <p className="text-sm text-secondary">
                  This form doesn&apos;t have any questions yet — check back later.
                </p>
              ) : (
                <AnimatePresence initial={false}>
                  {shown.map((question, index) => (
                    <Motion.section
                      key={question.id}
                      layout="position"
                      id={`q-${question.id}`}
                      initial={{ opacity: 0, height: 0, y: -8 }}
                      animate={{ opacity: 1, height: "auto", y: 0 }}
                      exit={{ opacity: 0, height: 0, transition: { duration: 0.18 } }}
                      transition={SPRING}
                      className="overflow-hidden"
                    >
                      <div className="rounded-large-element surface-secondary p-5 space-y-3">
                        <p className="font-mono text-xs font-normal">
                          {index + 1} of {shown.length}
                          {question.required ? " · required" : ""}
                        </p>
                        <h2 className="text-base text-primary" id={`q-${question.id}-label`}>
                          {question.label || "Untitled question"}
                        </h2>
                        {question.help ? (
                          <p className="text-sm text-primary">{question.help}</p>
                        ) : null}
                        {question.image ? (
                          <img
                            src={`/s/${encodeURIComponent(token)}/form-image?name=${encodeURIComponent(question.image)}`}
                            alt={question.label ? `Picture for “${question.label}”` : "Picture for this question"}
                            className="max-h-64 w-full rounded-large-element object-contain surface-primary"
                          />
                        ) : null}
                        <QuestionField
                          key={`${session}:${question.id}`}
                          question={question}
                          value={answers[question.id]}
                          error={errors[question.id] || ""}
                          token={token}
                          sharePassword={sharePassword}
                          onAnswer={(value) => setAnswer(question.id, value)}
                        />
                      </div>
                    </Motion.section>
                  ))}
                </AnimatePresence>
              )}

              {submitError && <PageNotice variant="error">{submitError}</PageNotice>}

              {shown.length > 0 && (
                <Motion.div layout="position" transition={SPRING} className="flex justify-end">
                  <Button variant="secondary" surface="primary" type="submit" disabled={submitting}>
                    {submitting ? "Sending…" : isEdit ? "Save changes" : "Send answers"}
                    <Send size={ICON_SIZE.sm} aria-hidden="true" />
                  </Button>
                </Motion.div>
              )}
            </div>
          </form>
        </StageMotion>
      )}
    </AnimatePresence>
  );
}

Responder.propTypes = FormResponder.propTypes;

/** @type {import("motion/react").Transition} */
const SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 };

/** Screens cross-fade and rise when the stage changes. */
function StageMotion({ children, className = "flex min-h-0 flex-1 flex-col" }) {
  return (
    <Motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
      className={className}
    >
      {children}
    </Motion.div>
  );
}

StageMotion.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
};

/**
 * @param {{
 *   title: string,
 *   editLink: string,
 *   canEdit: boolean,
 *   editCount: number,
 *   canRespondAgain: boolean,
 *   limitOne: boolean,
 *   onEdit: () => void,
 *   onRespondAgain: () => void,
 * }} props
 */
function DoneScreen({ title, editLink, canEdit, editCount, canRespondAgain, limitOne, onEdit, onRespondAgain }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-xl space-y-4 text-center">
        <Motion.div
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.05 }}
        >
          <CheckCircle2 size={ICON_SIZE.xl} className="mx-auto text-success" aria-hidden="true" />
        </Motion.div>
        <h1 className="font-mono text-2xl text-secondary">{title}</h1>
        {editLink && (
          <div className="space-y-2">
            <p className="text-sm text-secondary">
              Want to change your answers later, or from another device? Keep this link — it&apos;s only for you.
            </p>
            <CopyableValue value={editLink} surface="primary" />
          </div>
        )}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canEdit && (
            <Button variant="secondary" surface="primary" size="lg" onClick={onEdit}>
              {editCount === 1 ? "Change my answers" : "Change a response"}
            </Button>
          )}
          {canRespondAgain && (
            <Button variant="ghost" surface="primary" size="lg" onClick={onRespondAgain}>
              Send another response
            </Button>
          )}
        </div>
        {limitOne && (
          <p className="text-xs text-secondary">
            This form takes one response per person.
          </p>
        )}
      </div>
    </div>
  );
}

DoneScreen.propTypes = {
  title: PropTypes.string.isRequired,
  editLink: PropTypes.string,
  canEdit: PropTypes.bool,
  editCount: PropTypes.number,
  canRespondAgain: PropTypes.bool,
  limitOne: PropTypes.bool,
  onEdit: PropTypes.func.isRequired,
  onRespondAgain: PropTypes.func.isRequired,
};

/**
 * @param {{ title: string, subtitle: string, action?: import("react").ReactNode }} props
 */
function StageCard({ title, subtitle, action }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <div className="w-full max-w-xl space-y-3 text-center">
        <h1 className="font-mono text-2xl text-secondary">{title}</h1>
        <p className="text-sm text-secondary">{subtitle}</p>
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
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="w-full max-w-xl space-y-4">
          <h1 className="font-mono text-xl text-secondary">Which response do you want to change?</h1>
          <div className="space-y-2">
            {responses.map((entry, i) => (
              <Motion.button
                key={entry.id}
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.04, 0.3) }}
                whileTap={{ scale: 0.98 }}
                className="flex w-full flex-col gap-1 rounded-large-element surface-secondary p-4 text-left motion-safe:transition-transform hover:motion-safe:translate-x-0.5 focus-visible:ring-2 focus-visible:ring-accent no-focus-outline"
                onClick={() => {
                  haptic("selection");
                  onPick(entry);
                }}
              >
                <span className="font-mono text-xs font-normal">Sent {formatSentAt(entry.at)}</span>
                <span className="truncate text-sm text-primary">
                  {responsePreview(entry, questions)}
                </span>
              </Motion.button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" surface="primary" onClick={onBack}>
              <ArrowLeft size={ICON_SIZE.sm} aria-hidden="true" />
              Back
            </Button>
          </div>
        </div>
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

const inputClass =
  "w-full rounded-pill border-2 border-secondary/30 surface-primary px-4 py-2 text-base outline-none no-focus-outline focus:border-accent focus-visible:border-accent";

/**
 * The mark in front of a choice: a dot that fills for one-pick questions, a
 * tick box for checkboxes. The pill keeps its surface when picked; the solid
 * mark and the accent outline carry the checked state.
 */
function ChoiceMark({ multi, checked }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center border-2 motion-safe:transition-colors motion-safe:duration-200",
        multi ? "rounded-md" : "rounded-full",
        checked ? "border-secondary surface-secondary" : "border-secondary/50",
      )}
    >
      {multi ? (
        <svg
          viewBox="0 0 12 12"
          fill="none"
          className={cn(
            "size-3 motion-safe:transition-transform motion-safe:duration-200",
            checked ? "scale-100" : "scale-0",
          )}
        >
          <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span
          className={cn(
            "size-2 rounded-full surface-primary motion-safe:transition-transform motion-safe:duration-200",
            checked ? "scale-100" : "scale-0",
          )}
        />
      )}
    </span>
  );
}

ChoiceMark.propTypes = {
  multi: PropTypes.bool,
  checked: PropTypes.bool,
};

/**
 * @param {{ multi?: boolean, checked: boolean, onClick: () => void, children: import("react").ReactNode }} props
 */
function ChoicePill({ multi = false, checked, onClick, children }) {
  return (
    <Motion.button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={checked}
      whileTap={{ scale: 0.98 }}
      className={cn(
        "flex w-full items-center gap-3 rounded-pill border-2 px-4 py-3 text-left text-base motion-safe:transition-colors",
        "focus-visible:ring-2 focus-visible:ring-accent no-focus-outline",
        "surface-primary",
        checked ? "border-accent" : "border-secondary/30 hover:border-secondary",
      )}
      onClick={() => {
        haptic("selection");
        onClick();
      }}
    >
      <ChoiceMark multi={multi} checked={checked} />
      <span className="min-w-0 flex-1">{children}</span>
    </Motion.button>
  );
}

ChoicePill.propTypes = {
  multi: PropTypes.bool,
  checked: PropTypes.bool.isRequired,
  onClick: PropTypes.func.isRequired,
  children: PropTypes.node,
};

/**
 * The answer control for one question, on the same card the editor shows.
 * Mounted fresh for every response opened (keyed by session), so nothing
 * typed for one response leaks into another.
 * @param {{
 *   question: object,
 *   value: unknown,
 *   error?: string,
 *   token: string,
 *   sharePassword?: string,
 *   onAnswer: (value: unknown) => void,
 * }} props
 */
function QuestionField({ question, value, error, token, sharePassword, onAnswer }) {
  const options = answerOptions(question);
  const allowOther = question?.config?.allowOther === true;
  const picked = Array.isArray(value) ? value.map(String) : value != null && value !== "" ? [String(value)] : [];
  const initialOther = allowOther ? picked.find((p) => !options.includes(p)) || "" : "";
  // "Other" keeps its own text and on/off state, so typing words that
  // happen to match an option doesn't flip the pick or clear the box.
  const [otherText, setOtherText] = useState(initialOther);
  const [otherOn, setOtherOn] = useState(initialOther !== "");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [fileLabel, setFileLabel] = useState("");
  const fileRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const otherRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const labelId = `q-${question.id}-label`;

  function focusField(e) {
    e.currentTarget.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }

  async function onFile(file) {
    if (!file) return;
    if (!isAllowedUploadName(file.name)) {
      haptic("error");
      setUploadError("Attach a photo (JPG, PNG, GIF, or WebP) or a PDF.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      haptic("error");
      setUploadError("That file is over 10 MB. Choose a smaller photo or PDF.");
      return;
    }
    setUploading(true);
    setUploadError("");
    try {
      const body = new FormData();
      body.append("file", file);
      const headers = withCsrfHeaders("POST");
      if (sharePassword) headers["X-Share-Password"] = sharePassword;
      const res = await fetch(`/s/${encodeURIComponent(token)}/respond-file`, {
        method: "POST",
        headers,
        body,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.name) {
        throw new Error((data && data.error) || "Luna couldn't attach that file. Try again.");
      }
      setFileLabel(file.name);
      onAnswer(data.name);
      haptic("success");
    } catch (err) {
      haptic("error");
      setUploadError(apiErrorMessage(err, "Luna couldn't attach that file. Try again."));
    } finally {
      setUploading(false);
    }
  }

  function pickOther(multi) {
    const next = !otherOn;
    setOtherOn(next);
    if (next) setTimeout(() => otherRef.current?.focus(), 0);
    if (multi) {
      const kept = picked.filter((p) => options.includes(p));
      onAnswer(next && otherText ? [...kept, otherText] : kept);
    } else {
      onAnswer(next ? otherText : "");
    }
  }

  function typeOther(text, multi) {
    setOtherText(text);
    setOtherOn(true);
    if (multi) {
      const kept = picked.filter((p) => options.includes(p));
      onAnswer(text ? [...kept, text] : kept);
    } else {
      onAnswer(text);
    }
  }

  const single = question.type === "choice" || question.type === "yes_no";
  const multi = question.type === "multi_choice";

  return (
    <div className="space-y-3">
      {single || multi ? (
        <div
          className="flex flex-col gap-2"
          role={multi ? "group" : "radiogroup"}
          aria-labelledby={labelId}
        >
          {options.map((option) => {
            const stored = question.type === "yes_no" ? (option === "Yes" ? "yes" : "no") : option;
            const checked = multi ? picked.includes(option) : !otherOn && value === stored;
            return (
              <ChoicePill
                key={option}
                multi={multi}
                checked={checked}
                onClick={() => {
                  if (multi) {
                    onAnswer(checked ? picked.filter((p) => p !== option) : [...picked, option]);
                  } else {
                    setOtherOn(false);
                    onAnswer(stored);
                  }
                }}
              >
                {option}
              </ChoicePill>
            );
          })}
          {allowOther && question.type !== "yes_no" && (
            <div className="flex flex-col gap-2">
              <ChoicePill multi={multi} checked={otherOn} onClick={() => pickOther(multi)}>
                Other
              </ChoicePill>
              <AnimatePresence initial={false}>
                {otherOn ? (
                  <Motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={SPRING}
                    className="overflow-hidden"
                  >
                    <input
                      ref={otherRef}
                      className={inputClass}
                      value={otherText}
                      onFocus={focusField}
                      onChange={(e) => typeOther(e.target.value, multi)}
                      placeholder="Type your answer"
                      aria-label="Other answer"
                    />
                  </Motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          )}
        </div>
      ) : question.type === "dropdown" ? (
        <div className="space-y-2">
          <Dropdown
            options={[
              ...options.map((option) => ({ value: option, label: option })),
              ...(allowOther ? [{ value: OTHER_VALUE, label: "Other" }] : []),
            ]}
            value={otherOn ? OTHER_VALUE : options.includes(String(value ?? "")) ? String(value) : ""}
            onChange={(next) => {
              if (next === OTHER_VALUE) {
                setOtherOn(true);
                onAnswer(otherText);
                setTimeout(() => otherRef.current?.focus(), 0);
              } else {
                setOtherOn(false);
                onAnswer(next);
              }
            }}
            placeholder="Pick one…"
            bg="primary"
            fullWidth
            aria-label={question.label || "Pick one"}
          />
          <AnimatePresence initial={false}>
            {allowOther && otherOn ? (
              <Motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={SPRING}
                className="overflow-hidden"
              >
                <input
                  ref={otherRef}
                  className={inputClass}
                  value={otherText}
                  onFocus={focusField}
                  onChange={(e) => typeOther(e.target.value, false)}
                  placeholder="Type your answer"
                  aria-label="Other answer"
                />
              </Motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : question.type === "date" ? (
        <input
          type="date"
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value)}
          aria-labelledby={labelId}
        />
      ) : question.type === "number" ? (
        <input
          type="number"
          inputMode="decimal"
          className={inputClass}
          value={value == null ? "" : String(value)}
          min={typeof question.config?.min === "number" ? question.config.min : undefined}
          max={typeof question.config?.max === "number" ? question.config.max : undefined}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value === "" ? "" : Number(e.target.value))}
          placeholder="0"
          aria-labelledby={labelId}
        />
      ) : question.type === "email" ? (
        <input
          type="email"
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value)}
          placeholder="name@example.com"
          aria-labelledby={labelId}
          autoComplete="email"
        />
      ) : question.type === "file" ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              surface="secondary"
              disabled={uploading}
              aria-describedby={labelId}
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={ICON_SIZE.sm} aria-hidden="true" />
              {uploading ? "Attaching…" : typeof value === "string" && value ? "Attach a different file" : "Attach a photo or PDF"}
            </Button>
            {typeof value === "string" && value && !uploading ? (
              <Button
                type="button"
                variant="ghost"
                surface="secondary"
                onClick={() => {
                  setFileLabel("");
                  onAnswer("");
                }}
              >
                <X size={ICON_SIZE.sm} aria-hidden="true" />
                Remove
              </Button>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={FILE_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              onFile(file);
            }}
          />
          {typeof value === "string" && value ? (
            <p className="text-sm text-primary">
              Attached: {fileLabel || "your file"}
            </p>
          ) : null}
          {uploadError && <p className="text-sm text-error">{uploadError}</p>}
        </div>
      ) : question.type === "long_text" ? (
        <textarea
          className={cn(inputClass, "rounded-large-element min-h-32 resize-y")}
          value={typeof value === "string" ? value : ""}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value)}
          placeholder="Type your answer"
          aria-labelledby={labelId}
        />
      ) : (
        <input
          type="text"
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value)}
          placeholder="Type your answer"
          aria-labelledby={labelId}
        />
      )}
      <AnimatePresence initial={false}>
        {error ? (
          <Motion.p
            key="error"
            role="alert"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="text-sm text-error"
          >
            {error}
          </Motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Dropdown value for the Other entry — never stored as an answer. */
const OTHER_VALUE = "\u0000other";

QuestionField.propTypes = {
  question: PropTypes.object.isRequired,
  value: PropTypes.any,
  error: PropTypes.string,
  token: PropTypes.string.isRequired,
  sharePassword: PropTypes.string,
  onAnswer: PropTypes.func.isRequired,
};
