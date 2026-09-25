import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, Send } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
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
} from "./questionTypes.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

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
export default function FormResponder({
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
    : "Sent — thank you";

  const [answers, setAnswers] = useState(/** @type {Record<string, unknown>} */ ({}));
  const [editToken, setEditToken] = useState("");
  const [responseId, setResponseId] = useState("");
  const [isEdit, setIsEdit] = useState(false);
  const urlEdit = (searchParams.get("edit") || "").trim();
  const storedNow = readStoredResponses(token);
  const remembered = readCookie(cookieName("done", token)) === "1" || storedNow.length > 0;
  const [alreadyDone, setAlreadyDone] = useState(!urlEdit && limitOne && remembered);
  const [checkingEdit, setCheckingEdit] = useState(Boolean(urlEdit));
  const [editNotice, setEditNotice] = useState("");
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [filling, setFilling] = useState(!urlEdit && !(limitOne && remembered) && storedNow.length === 0);
  const [done, setDone] = useState(!urlEdit && !(limitOne && remembered) && storedNow.length > 0);
  /** True only for the screen right after a send — a return visit uses the older headings. */
  const [justSent, setJustSent] = useState(false);
  const [picking, setPicking] = useState(false);
  const [storedResponses, setStoredResponses] = useState(storedNow);

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
        setFilling(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setEditNotice(apiErrorMessage(err, "We couldn't find answers for that edit link. You can fill the form in fresh."));
        setFilling(true);
      })
      .finally(() => {
        if (!cancelled) setCheckingEdit(false);
      });
    return () => { cancelled = true; };
  }, [token, sharePassword, urlEdit]);

  const editableResponses = storedResponses.filter(
    (r) => typeof r.edit_token === "string" && r.edit_token !== "",
  );

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
    haptic("selection");
    setEditToken(typeof entry.edit_token === "string" ? entry.edit_token : "");
    setResponseId(entry.id);
    setAnswers(entry.answers && typeof entry.answers === "object" ? entry.answers : {});
    setIsEdit(true);
    setErrors({});
    setPicking(false);
    setDone(false);
    setFilling(true);
  }

  function respondAgain() {
    haptic("light");
    setAnswers({});
    setEditToken("");
    setResponseId("");
    setIsEdit(false);
    setErrors({});
    setSubmitError("");
    setDone(false);
    setFilling(true);
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
        next[q.id] = "That doesn't look like an email address.";
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
      haptic("error");
      setErrors(found);
      const first = shown.find((q) => found[q.id]);
      if (first) {
        document.getElementById(`q-${first.id}`)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
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
          (data && data.error) || "Couldn't send your answers. Try again in a moment.",
        );
      }
      const id = typeof data?.id === "string" ? data.id : responseId;
      writeCookie(cookieName("done", token), "1");
      if (id) {
        const entry = allowEdits
          ? {
              id,
              edit_token:
                data && typeof data.edit_token === "string" ? data.edit_token : tokenToUse,
              at: Date.now(),
              answers: answersToSend(),
            }
          : { id, at: Date.now(), answers: answersToSend() };
        const next = saveStoredResponse(token, entry);
        if (next) setStoredResponses(next);
      }
      setEditToken(
        allowEdits && data && typeof data.edit_token === "string" ? data.edit_token : tokenToUse,
      );
      if (id) setResponseId(id);
      setIsEdit(true);
      setFilling(false);
      setDone(true);
      setJustSent(true);
      haptic("success");
    } catch (err) {
      haptic("error");
      setSubmitError(apiErrorMessage(err, "Couldn't send your answers. Try again in a moment."));
    } finally {
      setSubmitting(false);
    }
  }

  const editLink = editToken ? `${window.location.origin}/s/${token}?edit=${editToken}` : "";

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
          setDone(true);
        }}
      />
    );
  }

  if (alreadyDone && !filling) {
    return (
      <StageCard
        title="You've already answered this form"
        subtitle="This form asks for one answer per person. This browser remembers that — it's a reminder, not a lock. Another device can still answer."
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {allowEdits && editableResponses.length > 0 && (
              <Button
                variant="accent"
                surface="secondary"
                onClick={() => {
                  if (editableResponses.length === 1) openEdit(editableResponses[0]);
                  else {
                    haptic("selection");
                    setPicking(true);
                  }
                }}
              >
                {editableResponses.length === 1 ? "Edit Response" : "Edit Responses"}
              </Button>
            )}
            <Button
              variant="ghost"
              surface="secondary"
              onClick={() => {
                haptic("light");
                setAlreadyDone(false);
                respondAgain();
              }}
            >
              Answer anyway
            </Button>
          </div>
        }
      />
    );
  }

  if (done && !filling) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
        <div className="w-full max-w-xl space-y-4 text-center">
          <CheckCircle2 size={ICON_SIZE.xl} className="mx-auto text-success" aria-hidden="true" />
          <h1 className="font-mono text-2xl text-secondary">
            {justSent
              ? thankYou
              : storedResponses.length === 1
                ? "You've answered this form"
                : `You've sent ${storedResponses.length} answers`}
          </h1>
          {allowEdits && editLink && (
            <div className="space-y-2">
              <p className="text-sm text-secondary">
                Want to change your answers later? Keep this link — it's only for you.
              </p>
              <CopyableValue value={editLink} surface="secondary" />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {allowEdits && editableResponses.length > 0 && (
              <Button
                variant="accent"
                surface="secondary"
                size="lg"
                onClick={() => {
                  if (editableResponses.length === 1) openEdit(editableResponses[0]);
                  else {
                    haptic("selection");
                    setPicking(true);
                  }
                }}
              >
                {editableResponses.length === 1 ? "Edit Response" : "Edit Responses"}
              </Button>
            )}
            {!limitOne && !full && (
              <Button variant="ghost" surface="secondary" size="lg" onClick={respondAgain}>
                Respond again
              </Button>
            )}
          </div>
          {limitOne && (
            <p className="text-xs text-accent">
              This form asks for one answer per person. This browser remembers that — it's a reminder, not a lock.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (full && !isEdit) {
    return (
      <StageCard
        title={form?.title || "This form"}
        subtitle={closedMessage || "This form has all the answers it can take."}
      />
    );
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="mx-auto w-full max-w-2xl space-y-4 p-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:p-6">
        {editNotice && <PageNotice variant="warning">{editNotice}</PageNotice>}
        <div className="rounded-large-element bg-primary text-secondary p-5 space-y-2">
          <h1 className="font-mono text-xl text-secondary">
            {isEdit ? "Change your answers" : (form?.title || "Untitled form")}
          </h1>
          {!isEdit && form?.description ? (
            <p className="whitespace-pre-wrap text-sm text-secondary">{form.description}</p>
          ) : null}
          {isEdit && (
            <p className="text-sm text-secondary">
              This is the same form. Change what you need, then send it again.
            </p>
          )}
        </div>

        {shown.length === 0 ? (
          <p className="text-sm text-secondary">
            This form doesn't have any questions yet — check back later.
          </p>
        ) : (
          shown.map((question, index) => (
            <section
              key={question.id}
              id={`q-${question.id}`}
              className="rounded-large-element bg-primary text-secondary p-5 space-y-3"
            >
              <p className="font-mono text-xs uppercase tracking-widest text-accent">
                {index + 1} of {shown.length}
                {question.required ? " · required" : ""}
              </p>
              <h2 className="text-base text-secondary">
                {question.label || "Untitled question"}
              </h2>
              {question.help ? (
                <p className="text-sm text-secondary">{question.help}</p>
              ) : null}
              {question.image ? (
                <img
                  src={`/s/${encodeURIComponent(token)}/form-image?path=${encodeURIComponent(question.image)}`}
                  alt=""
                  className="max-h-64 w-full rounded-large-element object-contain bg-secondary"
                />
              ) : null}
              <QuestionField
                question={question}
                value={answers[question.id]}
                error={errors[question.id] || ""}
                token={token}
                sharePassword={sharePassword}
                onAnswer={(value) => setAnswer(question.id, value)}
              />
            </section>
          ))
        )}

        {submitError && <PageNotice variant="error">{submitError}</PageNotice>}

        {shown.length > 0 && (
          <div className="flex justify-end">
            <Button variant="accent" surface="secondary" type="submit" disabled={submitting}>
              {submitting ? "Sending…" : isEdit ? "Save changes" : "Send answers"}
              <Send size={ICON_SIZE.sm} aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
    </form>
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
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
        <div className="w-full max-w-xl space-y-4">
          <h1 className="font-mono text-xl text-secondary">Which answer do you want to change?</h1>
          <div className="space-y-2">
            {responses.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="flex w-full flex-col gap-1 rounded-large-element bg-primary text-secondary p-4 text-left hover:bg-secondary/10 motion-safe:transition-colors"
                onClick={() => onPick(entry)}
              >
                <span className="font-mono text-xs text-accent">{formatSentAt(entry.at)}</span>
                <span className="truncate text-sm text-secondary">
                  {responsePreview(entry, questions)}
                </span>
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
 * The answer control for one question, on the same card the editor shows.
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
  const inputClass =
    "w-full rounded-pill border-2 border-secondary/30 bg-primary px-4 py-2 text-base text-secondary outline-none no-focus-outline focus:border-accent placeholder:text-accent";
  const picked = Array.isArray(value) ? value.map(String) : value != null && value !== "" ? [String(value)] : [];
  const otherText = allowOther
    ? picked.find((p) => !options.includes(p)) || ""
    : "";
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  function focusField(e) {
    e.currentTarget.scrollIntoView({ block: "center", behavior: "smooth" });
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
        throw new Error((data && data.error) || "Couldn't attach that file. Try again.");
      }
      onAnswer(data.name);
      haptic("success");
    } catch (err) {
      haptic("error");
      setUploadError(apiErrorMessage(err, "Couldn't attach that file. Try again."));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      {question.type === "choice" || question.type === "yes_no" ? (
        <div className="flex flex-col gap-2">
          {options.map((option) => {
            const stored = question.type === "yes_no" ? (option === "Yes" ? "yes" : "no") : option;
            const selected = value === stored;
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
                  onAnswer(stored);
                }}
              >
                {option}
              </button>
            );
          })}
          {allowOther && question.type === "choice" && (
            <OtherLine
              selected={otherText !== "" || value === "__other__"}
              text={otherText}
              onPick={() => onAnswer(otherText)}
              onText={(text) => onAnswer(text)}
            />
          )}
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
                  const next = selected ? picked.filter((p) => p !== option) : [...picked, option];
                  onAnswer(next);
                }}
              >
                {option}
              </button>
            );
          })}
          {allowOther && (
            <OtherLine
              selected={otherText !== ""}
              text={otherText}
              onPick={() => {
                if (!otherText) return;
                onAnswer([...picked.filter((p) => options.includes(p)), otherText]);
              }}
              onText={(text) => {
                const kept = picked.filter((p) => options.includes(p));
                onAnswer(text ? [...kept, text] : kept);
              }}
            />
          )}
        </div>
      ) : question.type === "dropdown" ? (
        <div className="space-y-2">
          <select
            className={inputClass}
            value={options.includes(String(value ?? "")) ? String(value) : otherText ? "__other__" : ""}
            onFocus={focusField}
            onChange={(e) => {
              if (e.target.value === "__other__") onAnswer(otherText);
              else onAnswer(e.target.value);
            }}
            aria-label={question.label || "Pick one"}
          >
            <option value="" disabled>Pick one…</option>
            {options.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
            {allowOther && <option value="__other__">Other</option>}
          </select>
          {allowOther && (otherText !== "" || value === "__other__" || (value && !options.includes(String(value)))) && (
            <input
              className={inputClass}
              value={otherText}
              onFocus={focusField}
              onChange={(e) => onAnswer(e.target.value)}
              placeholder="Type your answer"
              aria-label="Other answer"
            />
          )}
        </div>
      ) : question.type === "date" ? (
        <input
          type="date"
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value)}
          aria-label={question.label || "Pick a day"}
        />
      ) : question.type === "number" ? (
        <input
          type="number"
          className={inputClass}
          value={value == null ? "" : String(value)}
          min={typeof question.config?.min === "number" ? question.config.min : undefined}
          max={typeof question.config?.max === "number" ? question.config.max : undefined}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value === "" ? "" : Number(e.target.value))}
          placeholder="0"
          aria-label={question.label || "A number"}
        />
      ) : question.type === "email" ? (
        <input
          type="email"
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onFocus={focusField}
          onChange={(e) => onAnswer(e.target.value)}
          placeholder="name@example.com"
          aria-label={question.label || "Email"}
          autoComplete="email"
        />
      ) : question.type === "file" ? (
        <div className="space-y-2">
          <input
            type="file"
            accept={FILE_ACCEPT}
            className="block w-full text-sm text-secondary file:mr-3 file:rounded-pill file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:text-primary"
            aria-label={question.label || "Attach a file"}
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              onFile(file);
            }}
          />
          {uploading && <p className="text-sm text-accent">Attaching…</p>}
          {typeof value === "string" && value && (
            <p className="text-sm text-secondary">Attached</p>
          )}
          {uploadError && <PageNotice variant="error">{uploadError}</PageNotice>}
        </div>
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
  token: PropTypes.string.isRequired,
  sharePassword: PropTypes.string,
  onAnswer: PropTypes.func.isRequired,
};

/**
 * @param {{ selected: boolean, text: string, onPick: () => void, onText: (text: string) => void }} props
 */
function OtherLine({ selected, text, onPick, onText }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <button
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
          onPick();
        }}
      >
        Other
      </button>
      <input
        className="min-w-0 flex-1 rounded-pill border-2 border-secondary/30 bg-primary px-4 py-2 text-base text-secondary outline-none no-focus-outline focus:border-accent placeholder:text-accent"
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder="Type your answer"
        aria-label="Other answer"
      />
    </div>
  );
}

OtherLine.propTypes = {
  selected: PropTypes.bool,
  text: PropTypes.string,
  onPick: PropTypes.func.isRequired,
  onText: PropTypes.func.isRequired,
};
