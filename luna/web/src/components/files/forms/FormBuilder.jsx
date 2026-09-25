import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, GripVertical, ImagePlus, ListChecks, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import { CollabDocSync } from "../collabDocSync.js";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import Toggle from "@libreloom/ui/components/common/Toggle.jsx";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import ShareSheet from "../../share/ShareSheet.jsx";
import FormResponses from "./FormResponses.jsx";
import {
  answerOptions,
  defaultConfig,
  isImageFileName,
  QUESTION_TYPES,
  QUESTION_TYPE_IDS,
  typeInfo,
} from "./questionTypes.js";
import { apiErrorMessage } from "../../../lib/api.js";
import {
  latestResponses,
  newQuestionId,
  parseFormDocument,
  writeFormSeen,
} from "../../../lib/formDocument.js";
import {
  addFormQuestion,
  formCollabAdapter,
  moveFormQuestion,
  patchFormQuestion,
  readForm,
  removeFormQuestion,
  seedFormSnapshot,
  setFormDescription,
  setFormSetting,
  setFormTitle,
} from "../../../lib/formYDoc.js";
import { fileSourceScope, useFileSource } from "../../../lib/fileSource.jsx";
import { joinPath, parentPath } from "../../../lib/paths.js";
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
 * Questions live in a shared Y.Doc (see formYDoc). The file on the drive is
 * still the JSON envelope, so fields from a newer Luna version round-trip.
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
  const { addToast } = useToast();
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;
  const source = useFileSource();
  const scope = fileSourceScope(source, driveId);
  const solo = source.collab === false;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [doc, setDoc] = useState(/** @type {object | null} */ (null));
  /** Canonical JSON on the drive — the dirty baseline. */
  const [baseline, setBaseline] = useState(/** @type {string | null} */ (null));
  const [tab, setTab] = useState(/** @type {"questions" | "responses"} */ ("questions"));
  const [sharing, setSharing] = useState(false);
  const [peers, setPeers] = useState(/** @type {object[]} */ ([]));
  const [connStatus, setConnStatus] = useState(solo ? "open" : "connecting");
  const [focusHere, setFocusHere] = useState(/** @type {{ id: string, name: string }[]} */ ([]));
  /** Pending warn-and-allow confirmation for edits that touch answered data. */
  const [confirm, setConfirm] = useState(/** @type {null | { title: string, message: string, run: () => void }} */ (null));
  const [pickingImageFor, setPickingImageFor] = useState(/** @type {string | null} */ (null));
  const dragIndexRef = useRef(/** @type {number | null} */ (null));
  const [dropIndex, setDropIndex] = useState(/** @type {number | null} */ (null));
  const syncRef = useRef(/** @type {CollabDocSync | null} */ (null));

  const [sync] = useState(
    () =>
      new CollabDocSync({
        driveId,
        path,
        solo,
        adapter: formCollabAdapter(),
        onPeers: (next) => setPeers(next),
        onStatus: (status) => setConnStatus(status),
        onPeerSaved: () => {
          const session = syncRef.current;
          if (session) setBaseline(session.serialize());
        },
        onFormResponse: () => {
          queryClient.invalidateQueries({ queryKey: ["form-responses", scope, path] });
          addToastRef.current({ type: "success", message: "Someone just answered." });
        },
      }),
  );
  syncRef.current = sync;

  const responsesQuery = useQuery({
    queryKey: ["form-responses", scope, path],
    queryFn: () => source.formResponses(driveId, path),
    staleTime: 15_000,
    refetchInterval: 15_000,
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
  const lastEditRef = useRef(0);
  const dirtySinceRef = useRef(0);
  const lastSaveAttemptRef = useRef(0);
  const savingRef = useRef(false);

  useEffect(() => {
    if (tab !== "responses") return;
    writeFormSeen(scope, path, responses.length);
  }, [tab, scope, path, responses.length]);

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      setDoc(readForm(sync.ydoc));
      lastEditRef.current = Date.now();
    };
    const onAware = () => {
      const localId = sync.ydoc.clientID;
      /** @type {{ id: string, name: string }[]} */
      const here = [];
      for (const [clientId, state] of sync.awareness.getStates()) {
        if (clientId === localId) continue;
        const id = state?.questionId;
        if (typeof id !== "string" || !id) continue;
        const name = state?.user?.name;
        here.push({ id, name: typeof name === "string" && name ? name : "Someone" });
      }
      setFocusHere(here);
    };
    sync.ydoc.on("update", pull);
    sync.awareness.on("update", onAware);
    sync.connect();

    (async () => {
      try {
        const res = await source.fetch(source.contentHref(driveId, path));
        if (!res.ok) throw new Error("Luna couldn't open this form.");
        const text = await res.text();
        if (cancelled) return;
        const parsed = parseFormDocument(text);
        if (!parsed.ok) {
          setError(parsed.error || "Luna couldn't read this form.");
          return;
        }
        // Baseline is the canonical snapshot, so opening a form is not a
        // save even when key order in the file differs.
        setBaseline(seedFormSnapshot(text));
        sync.adoptContent(text);
        setDoc(readForm(sync.ydoc));
      } catch (err) {
        if (!cancelled) {
          setError(apiErrorMessage(err, "Luna couldn't open this form. Try downloading it."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      sync.ydoc.off("update", pull);
      sync.awareness.off("update", onAware);
      sync.disconnect();
    };
  }, [sync, driveId, path, source]);

  const isDirty =
    canWrite && sync.hydrated && baseline != null && sync.serialize() !== baseline;
  useEffect(() => {
    if (isDirty) onSaveStateChange(true);
  }, [isDirty, onSaveStateChange]);

  const save = useCallback(async () => {
    const session = syncRef.current;
    if (!session || !session.hydrated || !canWrite || savingRef.current) return false;
    const body = session.serialize();
    if (!body) return false;
    savingRef.current = true;
    try {
      await source.saveFile(
        driveId,
        path,
        name,
        new Blob([body], { type: "application/json" }),
      );
      setBaseline(body);
      session.notifySaved(body.length);
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
    if (loading || error || !canWrite) return undefined;
    const id = setInterval(() => {
      const session = syncRef.current;
      const now = Date.now();
      const dirty =
        session != null &&
        session.hydrated &&
        baselineRef.current != null &&
        session.serialize() !== baselineRef.current;
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
  }, [loading, error, canWrite]);

  // Register the save thunk once the document is up — same "no session, no
  // save" contract as the text editor.
  useEffect(() => {
    if (loading || error || !doc || !canWrite) return undefined;
    onRegisterSave(save);
    return () => onRegisterSave(null);
  }, [loading, error, doc, canWrite, save, onRegisterSave]);

  /** Local edit. Viewers never write — the hub would reject the op. */
  function edit(apply) {
    if (!canWrite) return;
    apply(sync.ydoc);
  }

  function setSetting(key, value) {
    edit((ydoc) => setFormSetting(ydoc, key, value));
  }

  function updateQuestion(id, patch) {
    edit((ydoc) => patchFormQuestion(ydoc, id, patch));
  }

  function focusQuestion(id) {
    sync.awareness.setLocalStateField("questionId", id || null);
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
    edit((ydoc) => addFormQuestion(ydoc, {
      v: 1,
      id: newQuestionId(),
      type,
      label: "",
      required: false,
      config: defaultConfig(type),
    }));
  }

  function removeQuestion(question) {
    guardedChange(
      question.id,
      "Remove this question?",
      answeredIds.has(question.id)
        ? "People have already answered it. Their answers stay in the results — only the question goes away."
        : "This removes the question from the form.",
      () => edit((ydoc) => removeFormQuestion(ydoc, question.id)),
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
    edit((ydoc) => moveFormQuestion(ydoc, from, to));
  }

  const peerNames = peers.map((p) => p.username).filter(Boolean).join(", ");
  const connNote = solo
    ? ""
    : connStatus === "open"
      ? peers.length > 0
        ? `Editing together: ${peerNames}`
        : ""
      : connStatus === "connecting" || connStatus === "reconnecting"
        ? "Connecting…"
        : "Offline — your changes stay here and sync when Luna reconnects";

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
          onChange={(v) => {
            setTab(v === "responses" ? "responses" : "questions");
          }}
          surface="primary"
          aria-label="Form section"
        />
        <div className="flex min-w-0 items-center gap-1">
          {peers.length > 0 && (
            <span
              className="mr-1 flex items-center"
              role="img"
              aria-label={`Also editing: ${peerNames}`}
              title={`Also editing: ${peerNames}`}
            >
              {peers.slice(0, 5).map((peer) => (
                <span
                  key={peer.peer_id}
                  className="-ml-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[0.65rem] text-secondary ring-2 ring-primary first:ml-0"
                  style={{ boxShadow: `inset 0 0 0 2px ${peer.color}` }}
                  aria-hidden="true"
                >
                  {String(peer.username || "?").slice(0, 1).toUpperCase()}
                </span>
              ))}
            </span>
          )}
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
      </div>
      {connNote ? (
        <p className="truncate border-b border-secondary/15 px-3 py-1 text-xs text-accent" role="status">
          {connNote}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading || (!error && !doc) ? (
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
            driveId={driveId}
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
            <div className="rounded-large-element bg-secondary text-primary p-5 space-y-3">
              <input
                className="w-full bg-transparent font-mono text-xl font-normal text-primary outline-none no-focus-outline placeholder:text-accent"
                value={doc?.title || ""}
                onChange={(e) => edit((ydoc) => setFormTitle(ydoc, e.target.value))}
                placeholder="Form title"
                aria-label="Form title"
                disabled={!canWrite}
              />
              <textarea
                className="w-full resize-none bg-transparent text-sm text-primary outline-none no-focus-outline placeholder:text-accent"
                rows={2}
                value={doc?.description || ""}
                onChange={(e) => edit((ydoc) => setFormDescription(ydoc, e.target.value))}
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
                earlier={questions.slice(0, index)}
                watchers={focusHere.filter((p) => p.id === question.id)}
                imageHref={question.image ? source.contentHref(driveId, question.image) : ""}
                onFocus={() => focusQuestion(question.id)}
                onBlur={() => focusQuestion("")}
                onPickImage={() => setPickingImageFor(question.id)}
                onPatch={(patch) => updateQuestion(question.id, patch)}
                onChangeType={(type) => changeType(question, type)}
                onRemove={() => removeQuestion(question)}
                onMove={(to) => moveQuestion(index, to)}
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

            <div className="rounded-large-element bg-secondary text-primary p-5 space-y-4">
              <h3 className="font-mono text-xs font-normal uppercase tracking-widest text-primary">
                Settings
              </h3>
              <Toggle
                surface="secondary"
                label="Collecting answers"
                description="Turn this off and the link stops taking new answers."
                checked={settings.collecting !== false}
                disabled={!canWrite}
                onChange={(next) => setSetting("collecting", next)}
              />
              <Toggle
                surface="secondary"
                label="Let people change their answers"
                description="Each person gets a private edit link after sending."
                checked={settings.allowEdits !== false}
                disabled={!canWrite}
                onChange={(next) => setSetting("allowEdits", next)}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm text-primary">Answers per person</p>
                  <p className="text-xs text-accent">
                    Limiting to one uses this device&apos;s browser memory — a reminder, not a lock.
                  </p>
                </div>
                <SegmentedControl
                  options={[
                    { value: "one", label: "One", disabled: !canWrite },
                    { value: "unlimited", label: "Unlimited", disabled: !canWrite },
                  ]}
                  value={settings.responseLimit === "one" ? "one" : "unlimited"}
                  onChange={(v) => setSetting("responseLimit", v === "one" ? "one" : "unlimited")}
                  surface="secondary"
                  aria-label="Answers per person"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-sm text-primary" htmlFor="form-thank-you">
                  Thank-you message
                </label>
                <textarea
                  id="form-thank-you"
                  className="w-full resize-none rounded-large-element border-2 border-secondary/30 bg-primary px-4 py-2 text-sm text-secondary outline-none no-focus-outline focus:border-accent placeholder:text-accent"
                  rows={2}
                  value={settings.thankYou || ""}
                  onChange={(e) => setSetting("thankYou", e.target.value)}
                  placeholder="Sent — thank you"
                  aria-label="Thank-you message"
                  disabled={!canWrite}
                />
                <p className="text-xs text-accent">
                  People see this after they send. Leave it blank and Luna says Sent — thank you.
                </p>
              </div>
              <div className="space-y-1">
                <label className="block text-sm text-primary" htmlFor="form-close-on">
                  Stop taking answers after
                </label>
                <input
                  id="form-close-on"
                  type="date"
                  className="rounded-pill border-2 border-secondary/30 bg-primary px-4 py-1.5 text-sm text-secondary outline-none no-focus-outline focus:border-accent"
                  value={settings.closeOn || ""}
                  onChange={(e) => setSetting("closeOn", e.target.value)}
                  aria-label="Stop taking answers after"
                  disabled={!canWrite}
                />
                <p className="text-xs text-accent">The form stays open through that day.</p>
              </div>
              <div className="space-y-1">
                <label className="block text-sm text-primary" htmlFor="form-max-responses">
                  Stop after this many answers
                </label>
                <input
                  id="form-max-responses"
                  type="number"
                  min="1"
                  className="w-32 rounded-pill border-2 border-secondary/30 bg-primary px-4 py-1.5 text-sm text-secondary outline-none no-focus-outline focus:border-accent"
                  value={settings.maxResponses ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setSetting("maxResponses", raw === "" ? null : Number(raw));
                  }}
                  aria-label="Stop after this many answers"
                  disabled={!canWrite}
                />
                <p className="text-xs text-accent">
                  Leave this empty for no limit. Changing an answer does not count as a new one.
                </p>
              </div>
              <Toggle
                surface="secondary"
                label="Tell me when someone answers"
                description="Shows a short note. Luna does not email you."
                checked={settings.notify !== false}
                disabled={!canWrite}
                onChange={(next) => setSetting("notify", next)}
              />
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

      {pickingImageFor && (
        <PicturePicker
          driveId={driveId}
          startFolder={parentPath(path) ?? ""}
          onClose={() => setPickingImageFor(null)}
          onPick={(imagePath) => {
            const id = pickingImageFor;
            setPickingImageFor(null);
            if (id) updateQuestion(id, { image: imagePath });
          }}
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
const fieldClass =
  "rounded-pill border-2 border-secondary/30 bg-primary px-4 py-1.5 text-sm text-secondary outline-none no-focus-outline focus:border-accent placeholder:text-accent";

/** The control a person fills in — same shape as the answer page, not a grey stand-in. */
const previewFieldClass =
  "pointer-events-none w-full rounded-pill border-2 border-secondary/30 bg-primary px-4 py-2 text-base text-secondary outline-none placeholder:text-accent";

const answerPillClass =
  "rounded-pill border-2 border-secondary/30 bg-primary px-4 py-3 text-left text-base text-secondary";

function QuestionCard({
  question,
  index,
  count,
  canWrite,
  hasAnswers,
  dragging,
  earlier = [],
  watchers = [],
  imageHref,
  onFocus,
  onBlur,
  onPickImage,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onPatch,
  onChangeType,
  onRemove,
  onMove,
  onRemoveOption,
}) {
  const info = typeInfo(question.type);
  const options = answerOptions(question);

  function setOptions(next) {
    onPatch({ config: { ...(question.config || {}), options: next } });
  }

  function setBound(key, raw) {
    const config = { ...(question.config || {}) };
    if (raw === "") delete config[key];
    else {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      config[key] = n;
    }
    onPatch({ config });
  }

  const showOther = question.config?.allowOther === true;

  return (
    <div
      className={cn(
        "rounded-large-element bg-secondary text-primary p-5 space-y-3 motion-safe:transition-colors",
        dragging && "ring-2 ring-accent",
      )}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onFocus={onFocus}
      onBlur={onBlur}
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
        {canWrite && (
          <>
            <Button
              variant="ghost"
              surface="secondary"
              size="iconSm"
              aria-label="Move this question up"
              tooltip="Move this question up"
              disabled={index === 0}
              onClick={() => onMove(index - 1)}
            >
              <ChevronUp size={ICON_SIZE.sm} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              surface="secondary"
              size="iconSm"
              aria-label="Move this question down"
              tooltip="Move this question down"
              disabled={index >= count - 1}
              onClick={() => onMove(index + 1)}
            >
              <ChevronDown size={ICON_SIZE.sm} aria-hidden="true" />
            </Button>
          </>
        )}
        <span className="font-mono text-xs font-normal uppercase tracking-widest text-accent">
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
          <span className="rounded-pill bg-primary px-3 py-1 font-mono text-xs font-normal text-secondary">
            {info.label}
          </span>
        )}
        {canWrite && (
          <Button
            variant="ghost"
            surface="secondary"
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
        className="w-full bg-transparent text-base text-primary outline-none no-focus-outline placeholder:text-accent"
        value={question.label || ""}
        onChange={(e) => onPatch({ label: e.target.value })}
        placeholder="Type the question"
        aria-label={`Question ${index + 1}`}
        disabled={!canWrite}
      />

      {question.help ? (
        <p className="text-sm text-primary">{question.help}</p>
      ) : null}

      {question.image ? (
        <img
          src={imageHref}
          alt=""
          className="max-h-48 w-full rounded-large-element bg-primary object-contain"
        />
      ) : null}

      {watcherLine(watchers) ? (
        <p className="text-xs text-accent">{watcherLine(watchers)}</p>
      ) : null}

      <QuestionFace
        question={question}
        options={options}
        canWrite={canWrite}
        showOther={showOther}
        onSetOptions={setOptions}
        onRemoveOption={onRemoveOption}
      />

      <div className="space-y-3 border-t border-primary/20 pt-3">
        {info.hint ? <p className="text-xs text-accent">{info.hint}</p> : null}
        <input
          className={fieldClass + " w-full"}
          value={question.help || ""}
          onChange={(e) => onPatch({ help: e.target.value })}
          placeholder="Add a hint under the question (optional)"
          aria-label={`Hint for question ${index + 1}`}
          disabled={!canWrite}
        />
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" surface="secondary" size="sm" onClick={onPickImage}>
              <ImagePlus size={ICON_SIZE.sm} aria-hidden="true" />
              {question.image ? "Change picture" : "Add a picture"}
            </Button>
            {question.image ? (
              <Button
                variant="ghost"
                surface="secondary"
                size="sm"
                onClick={() => onPatch({ image: "" })}
              >
                Remove picture
              </Button>
            ) : null}
          </div>
        )}
        {info.options && question.type === "dropdown" && (
          <OptionEditor
            options={options}
            canWrite={canWrite}
            onSetOptions={setOptions}
            onRemoveOption={onRemoveOption}
          />
        )}
        {info.options && canWrite && question.type !== "dropdown" && (
          <Button
            variant="outline"
            surface="secondary"
            size="sm"
            onClick={() => setOptions([...options, `Option ${options.length + 1}`])}
          >
            <Plus size={ICON_SIZE.sm} aria-hidden="true" />
            Add an option
          </Button>
        )}
        {info.options && (
          <Toggle
            surface="secondary"
            label="Let people type their own answer"
            checked={showOther}
            disabled={!canWrite}
            onChange={(next) => {
              const config = { ...(question.config || {}) };
              if (next) config.allowOther = true;
              else delete config.allowOther;
              onPatch({ config });
            }}
          />
        )}
        {question.type === "number" && (
          <div className="flex flex-wrap gap-2">
            <input
              type="number"
              className={cn(fieldClass, "w-36")}
              value={question.config?.min ?? ""}
              onChange={(e) => setBound("min", e.target.value)}
              aria-label="Smallest number"
              placeholder="No minimum"
              disabled={!canWrite}
            />
            <input
              type="number"
              className={cn(fieldClass, "w-36")}
              value={question.config?.max ?? ""}
              onChange={(e) => setBound("max", e.target.value)}
              aria-label="Largest number"
              placeholder="No maximum"
              disabled={!canWrite}
            />
          </div>
        )}
        {earlier.length > 0 && (
          <SkipRow question={question} earlier={earlier} canWrite={canWrite} onPatch={onPatch} />
        )}
        <div className="flex items-center justify-between gap-2">
          {hasAnswers && (
            <span className="text-xs text-accent">People have answered this</span>
          )}
          <div className="min-w-0 flex-1" />
          <Toggle
            surface="secondary"
            label="Required"
            checked={Boolean(question.required)}
            disabled={!canWrite}
            onChange={(next) => onPatch({ required: next })}
          />
        </div>
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
  earlier: PropTypes.array,
  watchers: PropTypes.array,
  imageHref: PropTypes.string,
  onFocus: PropTypes.func,
  onBlur: PropTypes.func,
  onPickImage: PropTypes.func,
  onDragStart: PropTypes.func.isRequired,
  onDragOver: PropTypes.func.isRequired,
  onDrop: PropTypes.func.isRequired,
  onDragEnd: PropTypes.func.isRequired,
  onPatch: PropTypes.func.isRequired,
  onChangeType: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
  onMove: PropTypes.func.isRequired,
  onRemoveOption: PropTypes.func.isRequired,
};

/** @param {{ id: string, name: string }[]} watchers */
function watcherLine(watchers) {
  const names = (watchers || []).map((w) => w.name).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is on this question`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are on this question`;
  return `${names[0]} and ${names.length - 1} others are on this question`;
}

/**
 * The face of a question — the same control the answer page shows.
 * Choice pills stay editable because those words are what people pick.
 * Dropdown options live in the footer so the face is a dropdown.
 */
function QuestionFace({ question, options, canWrite, showOther, onSetOptions, onRemoveOption }) {
  if (question.type === "dropdown") {
    return (
      <div
        aria-hidden="true"
        className="inline-flex w-full items-center rounded-pill bg-primary px-3 py-1.5 text-xs text-secondary"
      >
        <span className="inline-flex w-full items-center justify-between gap-1 font-mono font-normal">
          Pick one…
          <ChevronDown size={ICON_SIZE.sm} aria-hidden="true" />
        </span>
      </div>
    );
  }

  if (question.type === "choice" || question.type === "multi_choice") {
    return (
      <div className="flex flex-col gap-2">
        {options.map((option, optionIndex) => (
          <div key={optionIndex} className="flex items-center gap-2">
            <input
              className={cn(answerPillClass, "min-w-0 flex-1 outline-none no-focus-outline focus:border-accent")}
              value={option}
              onChange={(e) => {
                const next = [...options];
                next[optionIndex] = e.target.value;
                onSetOptions(next);
              }}
              aria-label={`Option ${optionIndex + 1}`}
              disabled={!canWrite}
            />
            {canWrite && (
              <Button
                variant="ghost"
                surface="secondary"
                size="iconSm"
                aria-label={`Remove option ${optionIndex + 1}`}
                onClick={() => onRemoveOption(optionIndex)}
              >
                <Trash2 size={ICON_SIZE.xs} aria-hidden="true" />
              </Button>
            )}
          </div>
        ))}
        {showOther && (
          <div className={answerPillClass} aria-hidden="true">Other</div>
        )}
      </div>
    );
  }

  if (question.type === "yes_no") {
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        {["Yes", "No"].map((option) => (
          <div key={option} className={answerPillClass}>{option}</div>
        ))}
      </div>
    );
  }

  if (question.type === "long_text") {
    return (
      <textarea
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        rows={4}
        className={cn(previewFieldClass, "min-h-32 resize-y rounded-large-element")}
        placeholder="Type your answer"
      />
    );
  }

  if (question.type === "date") {
    return (
      <input
        type="date"
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className={previewFieldClass}
      />
    );
  }

  if (question.type === "number") {
    return (
      <input
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className={previewFieldClass}
        placeholder="0"
      />
    );
  }

  if (question.type === "email") {
    return (
      <input
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className={previewFieldClass}
        placeholder="name@example.com"
      />
    );
  }

  if (question.type === "file") {
    return (
      <div
        aria-hidden="true"
        className="inline-flex items-center gap-2 rounded-pill border-2 border-primary px-4 py-2 text-sm text-primary"
      >
        Attach a photo or PDF
      </div>
    );
  }

  return (
    <input
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      className={previewFieldClass}
      placeholder="Type your answer"
    />
  );
}

QuestionFace.propTypes = {
  question: PropTypes.object.isRequired,
  options: PropTypes.array.isRequired,
  canWrite: PropTypes.bool,
  showOther: PropTypes.bool,
  onSetOptions: PropTypes.func.isRequired,
  onRemoveOption: PropTypes.func.isRequired,
};

/** Option list for a dropdown — the face is the closed menu, so the words live here. */
function OptionEditor({ options, canWrite, onSetOptions, onRemoveOption }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-accent">Options in the list</p>
      {options.map((option, optionIndex) => (
        <div key={optionIndex} className="flex items-center gap-2">
          <input
            className={cn(fieldClass, "min-w-0 flex-1")}
            value={option}
            onChange={(e) => {
              const next = [...options];
              next[optionIndex] = e.target.value;
              onSetOptions(next);
            }}
            aria-label={`Option ${optionIndex + 1}`}
            disabled={!canWrite}
          />
          {canWrite && (
            <Button
              variant="ghost"
              surface="secondary"
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
          surface="secondary"
          size="sm"
          onClick={() => onSetOptions([...options, `Option ${options.length + 1}`])}
        >
          <Plus size={ICON_SIZE.sm} aria-hidden="true" />
          Add an option
        </Button>
      )}
    </div>
  );
}

OptionEditor.propTypes = {
  options: PropTypes.array.isRequired,
  canWrite: PropTypes.bool,
  onSetOptions: PropTypes.func.isRequired,
  onRemoveOption: PropTypes.func.isRequired,
};

/**
 * Skip when an earlier answer matches. Yes/no stores yes/no, not the label.
 */
function SkipRow({ question, earlier, canWrite, onPatch }) {
  const logic = question.logic && typeof question.logic.questionId === "string"
    ? question.logic
    : null;
  const trigger = earlier.find((q) => q.id === logic?.questionId) || null;
  const triggerInfo = trigger ? typeInfo(trigger.type) : null;

  function setLogic(questionId, equals) {
    if (!questionId) onPatch({ logic: null });
    else onPatch({ logic: { questionId, equals: equals == null ? "" : String(equals) } });
  }

  function defaultEquals(next) {
    if (!next) return "";
    if (next.type === "yes_no") return "yes";
    const opts = answerOptions(next);
    return opts[0] || "";
  }

  const questionOptions = [
    { value: "", label: "Don't skip" },
    ...earlier.map((q, i) => ({ value: q.id, label: q.label || `Question ${i + 1}` })),
  ];
  const equalsOptions = trigger?.type === "yes_no"
    ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]
    : answerOptions(trigger).map((option) => ({ value: option, label: option }));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-primary">Skip this question when</span>
      <Dropdown
        options={questionOptions}
        value={trigger ? trigger.id : ""}
        disabled={!canWrite}
        bg="primary"
        aria-label="Skip when this earlier question"
        onChange={(id) => {
          const next = earlier.find((q) => q.id === id) || null;
          setLogic(id, defaultEquals(next));
        }}
      />
      {trigger && (
        <>
          <span className="text-sm text-primary">is</span>
          {trigger.type === "yes_no" || triggerInfo?.options || triggerInfo?.fixedOptions ? (
            <Dropdown
              options={equalsOptions}
              value={trigger.type === "yes_no"
                ? (logic?.equals === "no" ? "no" : "yes")
                : (logic?.equals || "")}
              disabled={!canWrite}
              bg="primary"
              aria-label="Skip when the answer is"
              onChange={(value) => setLogic(trigger.id, value)}
            />
          ) : (
            <input
              className={cn(fieldClass, "min-w-32 flex-1")}
              aria-label="Skip when the answer is"
              value={logic?.equals || ""}
              disabled={!canWrite}
              onChange={(e) => setLogic(trigger.id, e.target.value)}
            />
          )}
        </>
      )}
    </div>
  );
}

SkipRow.propTypes = {
  question: PropTypes.object.isRequired,
  earlier: PropTypes.array.isRequired,
  canWrite: PropTypes.bool,
  onPatch: PropTypes.func.isRequired,
};

/**
 * Pick a picture that is already on the drive. The path is stored on the
 * question; respondents load it through the answer link.
 */
function PicturePicker({ driveId, startFolder, onPick, onClose }) {
  const source = useFileSource();
  const [folder, setFolder] = useState(startFolder);
  const listing = useQuery({
    queryKey: ["form-pictures", fileSourceScope(source, driveId), folder],
    queryFn: () => source.listDir(driveId, folder),
  });
  const entries = (Array.isArray(listing.data) ? listing.data : [])
    .filter((entry) => entry && !entry.hidden)
    .filter((entry) => entry.kind === "dir" || isImageFileName(entry.name));

  return (
    <ModalCard
      open
      title="Choose a picture"
      onClose={onClose}
      overlayClassName={NESTED_OVERLAY_CLASS}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 pr-10">
          <p className="min-w-0 flex-1 truncate font-mono text-xs font-normal uppercase tracking-widest text-primary">
            {folder || "Top folder"}
          </p>
          {folder ? (
            <Button
              variant="ghost"
              surface="secondary"
              size="sm"
              onClick={() => setFolder(parentPath(folder) ?? "")}
            >
              Up
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-primary">
          Choose a picture already on Luna. JPG, PNG, GIF, or WebP.
        </p>
        {listing.isError ? (
          <PageNotice variant="error">Couldn&apos;t open that folder. Try again.</PageNotice>
        ) : listing.isLoading ? (
          <div className="flex items-center gap-2" role="status">
            <Spinner size="sm" decorative />
            <span className="text-sm text-primary">Opening</span>
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-primary">No pictures in this folder.</p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {entries.map((entry) => {
              const isDir = entry.kind === "dir";
              return (
                <button
                  key={entry.name}
                  type="button"
                  className="flex w-full items-center rounded-large-element px-3 py-2 text-left text-sm text-primary hover:bg-primary/10"
                  onClick={() => {
                    haptic("selection");
                    const next = joinPath(folder, entry.name);
                    if (isDir) setFolder(next);
                    else onPick(next);
                  }}
                >
                  {isDir ? `Folder: ${entry.name}` : entry.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </ModalCard>
  );
}

PicturePicker.propTypes = {
  driveId: PropTypes.string.isRequired,
  startFolder: PropTypes.string.isRequired,
  onPick: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
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
