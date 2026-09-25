import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, ListChecks, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import Toggle from "@libreloom/ui/components/common/Toggle.jsx";
import { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import ShareSheet from "../../share/ShareSheet.jsx";
import FormResponses from "./FormResponses.jsx";
import {
  answerOptions,
  defaultConfig,
  QUESTION_TYPES,
  QUESTION_TYPE_IDS,
  typeInfo,
} from "./questionTypes.js";
import { apiErrorMessage } from "../../../lib/api.js";
import {
  latestResponses,
  newQuestionId,
  parseFormDocument,
  serializeFormDocument,
} from "../../../lib/formDocument.js";
import { fileSourceScope, useFileSource } from "../../../lib/fileSource.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

// Autosave mirrors TextFileEditor: fire once typing pauses for
// AUTOSAVE_IDLE_MS, never let unsaved work age past AUTOSAVE_MAX_MS during
// continuous editing, and back off AUTOSAVE_RETRY_MS after a failed save.
const AUTOSAVE_IDLE_MS = 2_000;
const AUTOSAVE_MAX_MS = 15_000;
const AUTOSAVE_RETRY_MS = 5_000;
const AUTOSAVE_TICK_MS = 250;

const TYPE_OPTIONS = QUESTION_TYPE_IDS.map((id) => ({
  value: id,
  label: QUESTION_TYPES[id].label,
}));

/**
 * Fullscreen WYSIWYG form builder — the `.lunaform` editor. Mounts inside
 * FullscreenEditorFrame and plugs into its save contract like TextFileEditor:
 * registers an upload thunk once the document is loaded and reports dirty
 * state so the frame's guard modal, Save button, and autosave tick all work.
 *
 * The builder edits the parsed document object and serializes the whole
 * thing back, so fields from a newer Luna version round-trip untouched.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   name: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onRegisterSave: (save: (() => Promise<unknown>) | null) => void,
 *   onSaveStateChange: (hasUnsaved: boolean) => void,
 * }} props
 */
export default function FormBuilder(props) {
  return <BuilderSession key={`${props.driveId}:${props.path}`} {...props} />;
}

FormBuilder.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
  onRegisterSave: PropTypes.func.isRequired,
  onSaveStateChange: PropTypes.func.isRequired,
};

/**
 * @param {{
 *   driveId: string,
 *   path: string,
 *   name: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onRegisterSave: (save: (() => Promise<unknown>) | null) => void,
 *   onSaveStateChange: (hasUnsaved: boolean) => void,
 * }} props
 */
function BuilderSession({
  driveId,
  path,
  name,
  canWrite = true,
  onSaved,
  onRegisterSave,
  onSaveStateChange,
}) {
  const queryClient = useQueryClient();
  const source = useFileSource();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [doc, setDoc] = useState(/** @type {object | null} */ (null));
  /** Serialized document on the drive — the dirty baseline. */
  const [baseline, setBaseline] = useState(/** @type {string | null} */ (null));
  const [tab, setTab] = useState(/** @type {"questions" | "responses"} */ ("questions"));
  const [sharing, setSharing] = useState(false);
  /** Pending warn-and-allow confirmation for edits that touch answered data. */
  const [confirm, setConfirm] = useState(/** @type {null | { title: string, message: string, run: () => void }} */ (null));
  const dragIndexRef = useRef(/** @type {number | null} */ (null));
  const [dropIndex, setDropIndex] = useState(/** @type {number | null} */ (null));

  const responsesQuery = useQuery({
    queryKey: ["form-responses", fileSourceScope(source, driveId), path],
    queryFn: () => source.formResponses(driveId, path),
    staleTime: 15_000,
  });
  const responses = latestResponses(
    Array.isArray(responsesQuery.data) ? responsesQuery.data : [],
  );
  /** Question ids that already have answers — editing those warns first. */
  const answeredIds = new Set(
    responses.flatMap((r) => (r && typeof r.answers === "object" && r.answers ? Object.keys(r.answers) : [])),
  );

  // Autosave bookkeeping — mirrors TextFileEditor.
  const baselineRef = useRef(/** @type {string | null} */ (null));
  baselineRef.current = baseline;
  const docRef = useRef(/** @type {object | null} */ (null));
  docRef.current = doc;
  const lastEditRef = useRef(0);
  const dirtySinceRef = useRef(0);
  const lastSaveAttemptRef = useRef(0);
  const savingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await source.fetch(source.contentHref(driveId, path));
        if (!res.ok) throw new Error("Luna couldn't open this form.");
        const text = await res.text();
        const parsed = parseFormDocument(text);
        if (cancelled) return;
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        setDoc(parsed.doc);
        setBaseline(serializeFormDocument(parsed.doc));
      } catch (err) {
        if (!cancelled) {
          setError(apiErrorMessage(err, "Luna couldn't open this form. Try downloading it."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [driveId, path, source]);

  const isDirty =
    doc != null && baseline != null && serializeFormDocument(doc) !== baseline;
  useEffect(() => {
    if (isDirty) onSaveStateChange(true);
  }, [isDirty, onSaveStateChange]);

  const save = useCallback(async () => {
    const current = docRef.current;
    if (!current || !canWrite || savingRef.current) return false;
    savingRef.current = true;
    try {
      const body = serializeFormDocument(current);
      await source.saveFile(
        driveId,
        path,
        name,
        new Blob([body], { type: "application/json" }),
      );
      setBaseline(body);
      onSaved?.();
      onSaveStateChange(false);
      return true;
    } finally {
      savingRef.current = false;
    }
  }, [source, canWrite, driveId, path, name, onSaved, onSaveStateChange]);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (loading || error) return undefined;
    const id = setInterval(() => {
      const current = docRef.current;
      const now = Date.now();
      const dirty =
        current != null &&
        baselineRef.current != null &&
        serializeFormDocument(current) !== baselineRef.current;
      if (!dirty) {
        dirtySinceRef.current = 0;
        return;
      }
      if (!dirtySinceRef.current) dirtySinceRef.current = now;
      if (savingRef.current) return;
      if (now - lastSaveAttemptRef.current < AUTOSAVE_RETRY_MS) return;
      const idle = now - lastEditRef.current;
      const stale = now - dirtySinceRef.current;
      if (idle >= AUTOSAVE_IDLE_MS || stale >= AUTOSAVE_MAX_MS) {
        lastSaveAttemptRef.current = now;
        saveRef.current?.().catch(() => {
          // keep editing; the tick retries after AUTOSAVE_RETRY_MS
        });
      }
    }, AUTOSAVE_TICK_MS);
    return () => clearInterval(id);
  }, [loading, error]);

  // Register the save thunk once the document is up — same "no session, no
  // save" contract as the text editor.
  useEffect(() => {
    if (loading || error || !doc || !canWrite) return undefined;
    onRegisterSave(save);
    return () => onRegisterSave(null);
  }, [loading, error, doc, canWrite, save, onRegisterSave]);

  // Any doc change marks the last-edit timestamp for the autosave tick —
  // kept in an effect so render-scope functions stay pure.
  useEffect(() => {
    if (doc != null) lastEditRef.current = Date.now();
  }, [doc]);

  /** Apply a mutation to the document, preserving unknown fields. */
  function updateDoc(mutate) {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      mutate(next);
      return next;
    });
  }

  function setSetting(key, value) {
    updateDoc((d) => { d.settings = { ...d.settings, [key]: value }; });
  }

  function updateQuestion(id, patch) {
    updateDoc((d) => {
      d.questions = d.questions.map((q) => (q.id === id ? { ...q, ...patch } : q));
    });
  }

  /** Warn-and-allow: a change that touches answered questions confirms first. */
  function guardedChange(questionId, title, message, apply) {
    if (answeredIds.has(questionId)) {
      haptic("warning");
      setConfirm({ title, message, run: apply });
    } else {
      apply();
    }
  }

  function addQuestion(type) {
    haptic("light");
    updateDoc((d) => {
      d.questions = [
        ...d.questions,
        {
          v: 1,
          id: newQuestionId(),
          type,
          label: "",
          required: false,
          config: defaultConfig(type),
        },
      ];
    });
  }

  function removeQuestion(question) {
    guardedChange(
      question.id,
      "Remove this question?",
      answeredIds.has(question.id)
        ? "People have already answered it. Their answers stay in the results — only the question goes away."
        : "This removes the question from the form.",
      () => updateDoc((d) => {
        d.questions = d.questions.filter((q) => q.id !== question.id);
      }),
    );
  }

  function changeType(question, type) {
    if (type === question.type) return;
    guardedChange(
      question.id,
      "Change the question type?",
      "People have already answered this question. Their answers stay in the results, but may not match the new type.",
      () => updateQuestion(question.id, { type, config: defaultConfig(type) }),
    );
  }

  function moveQuestion(from, to) {
    if (to < 0 || from === to) return;
    updateDoc((d) => {
      const list = [...d.questions];
      if (from < 0 || from >= list.length || to >= list.length) return;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      d.questions = list;
    });
  }

  const questions = Array.isArray(doc?.questions) ? doc.questions : [];
  const settings = doc?.settings || {};

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-secondary/15 px-3">
        <SegmentedControl
          options={[
            { value: "questions", label: "Questions", icon: Pencil },
            { value: "responses", label: `Responses${responses.length ? ` (${responses.length})` : ""}`, icon: ListChecks },
          ]}
          value={tab}
          onChange={(v) => setTab(v === "responses" ? "responses" : "questions")}
          surface="primary"
          aria-label="Form section"
        />
        {!source.guest && (
          <Button
            variant="ghost"
            surface="primary"
            size="iconSm"
            smoothResize={false}
            haptic="light"
            aria-label="Share this form"
            tooltip="Share this form"
            onClick={() => setSharing(true)}
          >
            <Share2 size={ICON_SIZE.md} aria-hidden="true" />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div
            className="flex h-full items-center justify-center"
            role="status"
            aria-label={`Opening ${name}`}
          >
            <div className="flex items-center gap-3 text-secondary">
              <p className="font-mono text-sm uppercase tracking-widest">Opening</p>
              <Spinner size="md" decorative />
            </div>
          </div>
        ) : error ? (
          <div className="p-4"><PageNotice variant="error">{error}</PageNotice></div>
        ) : tab === "responses" ? (
          <FormResponses
            formPath={path}
            questions={questions}
            responses={responses}
            loading={responsesQuery.isLoading}
            error={responsesQuery.isError
              ? apiErrorMessage(responsesQuery.error, "Couldn't load answers. Try again.")
              : null}
            onRefresh={() => queryClient.invalidateQueries({ queryKey: ["form-responses", fileSourceScope(source, driveId), path] })}
          />
        ) : (
          <div className="mx-auto w-full max-w-2xl space-y-4 p-4 sm:p-6">
            {/* Title + description edit inline — the builder is WYSIWYG, so
                this reads like the responder's first screen. */}
            <div className="rounded-large-element bg-primary text-secondary p-5 space-y-3">
              <input
                className="w-full bg-transparent font-mono text-xl text-secondary outline-none no-focus-outline placeholder:text-accent"
                value={doc?.title || ""}
                onChange={(e) => updateDoc((d) => { d.title = e.target.value; })}
                placeholder="Form title"
                aria-label="Form title"
                disabled={!canWrite}
              />
              <textarea
                className="w-full resize-none bg-transparent text-sm text-secondary outline-none no-focus-outline placeholder:text-accent"
                rows={2}
                value={doc?.description || ""}
                onChange={(e) => updateDoc((d) => { d.description = e.target.value; })}
                placeholder="Say what this form is for (optional)"
                aria-label="Form description"
                disabled={!canWrite}
              />
            </div>

            {questions.map((question, index) => {
              // Option values people already picked — removing a picked
              // option warns first; untouched ones just go away.
              const pickedValues = new Set(
                responses.flatMap((r) => {
                  const value = r?.answers?.[question.id];
                  return Array.isArray(value) ? value.map(String) : value != null ? [String(value)] : [];
                }),
              );
              return (
              <QuestionCard
                key={question.id}
                question={question}
                index={index}
                count={questions.length}
                canWrite={canWrite}
                hasAnswers={answeredIds.has(question.id)}
                dragging={dropIndex === index}
                onDragStart={(e) => {
                  dragIndexRef.current = index;
                  e.dataTransfer.effectAllowed = "move";
                  haptic("rigid");
                }}
                onDragOver={(e) => {
                  if (dragIndexRef.current == null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropIndex(index);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragIndexRef.current;
                  dragIndexRef.current = null;
                  setDropIndex(null);
                  if (from != null) {
                    haptic("medium");
                    moveQuestion(from, index);
                  }
                }}
                onDragEnd={() => {
                  dragIndexRef.current = null;
                  setDropIndex(null);
                }}
                onPatch={(patch) => updateQuestion(question.id, patch)}
                onChangeType={(type) => changeType(question, type)}
                onRemove={() => removeQuestion(question)}
                onRemoveOption={(optionIndex) => {
                  const apply = () =>
                    updateQuestion(question.id, {
                      config: {
                        ...(question.config || {}),
                        options: answerOptions(question).filter((_, i) => i !== optionIndex),
                      },
                    });
                  if (pickedValues.has(answerOptions(question)[optionIndex])) {
                    haptic("warning");
                    setConfirm({
                      title: "Remove this option?",
                      message: "Some answers picked it. Those answers stay in the results — the option just stops being offered.",
                      run: apply,
                    });
                  } else {
                    apply();
                  }
                }}
              />
              );
            })}

            {canWrite && (
              <div className="flex justify-center">
                <AddQuestionButton onAdd={addQuestion} />
              </div>
            )}

            <div className="rounded-large-element bg-primary text-secondary p-5 space-y-4">
              <h3 className="font-mono text-xs uppercase tracking-widest text-secondary">
                Settings
              </h3>
              <Toggle
                surface="primary"
                label="Collecting answers"
                description="Turn this off and the link stops taking new answers."
                checked={settings.collecting !== false}
                disabled={!canWrite}
                onChange={(next) => setSetting("collecting", next)}
              />
              <Toggle
                surface="primary"
                label="Let people change their answers"
                description="Each person gets a private edit link after sending."
                checked={settings.allowEdits !== false}
                disabled={!canWrite}
                onChange={(next) => setSetting("allowEdits", next)}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm text-secondary">Answers per person</p>
                  <p className="text-xs text-accent">
                    Limiting to one uses this device&apos;s browser memory — a reminder, not a lock.
                  </p>
                </div>
                <SegmentedControl
                  options={[
                    { value: "one", label: "One" },
                    { value: "unlimited", label: "Unlimited" },
                  ]}
                  value={settings.responseLimit === "one" ? "one" : "unlimited"}
                  onChange={(v) => setSetting("responseLimit", v === "one" ? "one" : "unlimited")}
                  surface="primary"
                  aria-label="Answers per person"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {sharing && !source.guest && (
        <ShareSheet
          open
          subject={{ kind: "path", driveId, path }}
          overlayClassName={NESTED_OVERLAY_CLASS}
          onClose={() => setSharing(false)}
        />
      )}

      <ConfirmModal
        open={confirm != null}
        variant="warning"
        title={confirm?.title || "Are you sure?"}
        message={confirm?.message || ""}
        confirmLabel="Yes, do it"
        overlayClassName={NESTED_OVERLAY_CLASS}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          confirm?.run();
          setConfirm(null);
        }}
      />
    </div>
  );
}

BuilderSession.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
  onRegisterSave: PropTypes.func.isRequired,
  onSaveStateChange: PropTypes.func.isRequired,
};

/**
 * One question in the builder — styled like the responder's card so what
 * you see is what people get.
 */
function QuestionCard({
  question,
  index,
  count,
  canWrite,
  hasAnswers,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onPatch,
  onChangeType,
  onRemove,
  onRemoveOption,
}) {
  const info = typeInfo(question.type);
  const options = answerOptions(question);

  function setOptions(next) {
    onPatch({ config: { ...(question.config || {}), options: next } });
  }

  return (
    <div
      className={cn(
        "rounded-large-element bg-primary text-secondary p-5 space-y-3 motion-safe:transition-colors",
        dragging && "ring-2 ring-accent",
      )}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-2">
        {canWrite && (
          <span
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            className="cursor-grab active:cursor-grabbing text-accent"
            aria-label={`Drag to reorder question ${index + 1}`}
            title="Drag to reorder"
          >
            <GripVertical size={ICON_SIZE.md} aria-hidden="true" />
          </span>
        )}
        <span className="font-mono text-xs uppercase tracking-widest text-accent">
          {index + 1} of {count}
        </span>
        <div className="min-w-0 flex-1" />
        {canWrite ? (
          <Dropdown
            options={TYPE_OPTIONS}
            value={QUESTION_TYPES[question.type] ? question.type : "short_text"}
            onChange={(v) => onChangeType(v)}
            bg="primary"
            aria-label="Question type"
          />
        ) : (
          <span className="rounded-pill bg-secondary text-primary px-3 py-1 font-mono text-xs">
            {info.label}
          </span>
        )}
        {canWrite && (
          <Button
            variant="ghost"
            surface="primary"
            size="iconSm"
            aria-label="Remove this question"
            tooltip="Remove this question"
            onClick={onRemove}
          >
            <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
          </Button>
        )}
      </div>

      <input
        className="w-full bg-transparent text-base text-secondary outline-none no-focus-outline placeholder:text-accent"
        value={question.label || ""}
        onChange={(e) => onPatch({ label: e.target.value })}
        placeholder="Type the question"
        aria-label={`Question ${index + 1}`}
        disabled={!canWrite}
      />

      {info.hint && <p className="text-xs text-accent">{info.hint}</p>}

      {/* Responder-shaped preview — for option types the options themselves
          are editable rows; for text-ish types a disabled field shows what
          people will see. */}
      {info.options ? (
        <div className="space-y-2">
          {options.map((option, optionIndex) => (
            <div key={optionIndex} className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-pill border-2 border-secondary/30 bg-primary px-4 py-1.5 text-sm text-secondary outline-none focus:border-accent"
                value={option}
                onChange={(e) => {
                  const next = [...options];
                  next[optionIndex] = e.target.value;
                  setOptions(next);
                }}
                aria-label={`Option ${optionIndex + 1}`}
                disabled={!canWrite}
              />
              {canWrite && (
                <Button
                  variant="ghost"
                  surface="primary"
                  size="iconSm"
                  aria-label={`Remove option ${optionIndex + 1}`}
                  onClick={() => onRemoveOption(optionIndex)}
                >
                  <Trash2 size={ICON_SIZE.xs} aria-hidden="true" />
                </Button>
              )}
            </div>
          ))}
          {canWrite && (
            <Button
              variant="outline"
              surface="primary"
              size="sm"
              onClick={() => setOptions([...options, `Option ${options.length + 1}`])}
            >
              <Plus size={ICON_SIZE.sm} aria-hidden="true" />
              Add an option
            </Button>
          )}
        </div>
      ) : info.fixedOptions ? (
        <div className="flex gap-2">
          {info.fixedOptions.map((option) => (
            <span
              key={option}
              className="rounded-pill border-2 border-secondary/30 px-4 py-1.5 text-sm text-secondary"
            >
              {option}
            </span>
          ))}
        </div>
      ) : question.type === "long_text" ? (
        <div className="rounded-large-element border-2 border-secondary/30 px-4 py-2 text-sm text-accent">
          A longer answer goes here
        </div>
      ) : question.type === "date" ? (
        <div className="rounded-pill border-2 border-secondary/30 px-4 py-1.5 text-sm text-accent inline-block">
          Pick a day
        </div>
      ) : (
        <div className="rounded-pill border-2 border-secondary/30 px-4 py-1.5 text-sm text-accent">
          A short answer goes here
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        {hasAnswers && (
          <span className="text-xs text-accent">People have answered this</span>
        )}
        <div className="min-w-0 flex-1" />
        <Toggle
          surface="primary"
          label="Required"
          checked={Boolean(question.required)}
          disabled={!canWrite}
          onChange={(next) => onPatch({ required: next })}
        />
      </div>
    </div>
  );
}

QuestionCard.propTypes = {
  question: PropTypes.object.isRequired,
  index: PropTypes.number.isRequired,
  count: PropTypes.number.isRequired,
  canWrite: PropTypes.bool,
  hasAnswers: PropTypes.bool,
  dragging: PropTypes.bool,
  onDragStart: PropTypes.func.isRequired,
  onDragOver: PropTypes.func.isRequired,
  onDrop: PropTypes.func.isRequired,
  onDragEnd: PropTypes.func.isRequired,
  onPatch: PropTypes.func.isRequired,
  onChangeType: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
  onRemoveOption: PropTypes.func.isRequired,
};

/** "+ Add a question" pill — picks a type from the registry. */
function AddQuestionButton({ onAdd }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        variant="accent"
        surface="secondary"
        onClick={() => {
          haptic("light");
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Plus size={ICON_SIZE.sm} aria-hidden="true" />
        Add a question
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Question types"
          className="absolute left-1/2 top-full z-10 mt-2 min-w-44 -translate-x-1/2 overflow-hidden rounded-large-element bg-secondary text-primary ring-inset ring-2 ring-accent animate-dropdown-open"
        >
          {QUESTION_TYPE_IDS.map((id) => {
            const Icon = QUESTION_TYPES[id].icon;
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-4 py-2 text-left font-mono text-sm text-primary hover:bg-primary/10 motion-safe:transition-colors"
                onClick={() => {
                  setOpen(false);
                  onAdd(id);
                }}
              >
                <Icon size={ICON_SIZE.sm} aria-hidden="true" />
                {QUESTION_TYPES[id].label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

AddQuestionButton.propTypes = {
  onAdd: PropTypes.func.isRequired,
};
