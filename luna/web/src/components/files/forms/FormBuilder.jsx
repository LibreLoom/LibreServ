import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, MotionConfig, Reorder, motion as Motion, useDragControls } from "motion/react";
import {
  ChevronDown,
  ChevronUp,
  CornerLeftUp,
  Folder,
  GripVertical,
  ImagePlus,
  ListChecks,
  Pencil,
  Plus,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { CollabDocSync } from "../collabDocSync.js";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import Toggle from "@libreloom/ui/components/common/Toggle.jsx";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import ShareSheet from "../../share/ShareSheet.jsx";
import DocumentLoadingScreen from "../DocumentLoadingScreen.jsx";
import FormResponses from "./FormResponses.jsx";
import FormInput from "../../common/forms/FormInput.jsx";
import {
  answerOptions,
  canTriggerSkip,
  defaultConfig,
  hasEditableOptions,
  isImageFileName,
  QUESTION_TYPES,
  QUESTION_TYPE_IDS,
  typeInfo,
  DEFAULT_THANK_YOU,
} from "./questionTypes.js";
import { apiErrorMessage } from "../../../lib/api.js";
import {
  latestResponses,
  newQuestionId,
  parseFormDocument,
  writeFormSeen,
} from "../../../lib/formDocument.js";
import {
  addFormOption,
  addFormQuestion,
  formCollabAdapter,
  moveFormQuestion,
  patchFormQuestion,
  readForm,
  removeFormOption,
  removeFormQuestion,
  repairQuestionIds,
  seedFormSnapshot,
  setFormDescription,
  setFormOptionLabel,
  setFormOptions,
  setFormSetting,
  setFormTitle,
} from "../../../lib/formYDoc.js";
import { fileSourceScope, requireOk, useFileSource } from "../../../lib/fileSource.jsx";
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
  icon: QUESTION_TYPES[id].icon,
}));

/** Cards and options spring into place; shared so everything moves alike. */
/** @type {import("motion/react").Transition} */
const SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 };
const CARD_ENTER = { opacity: 0, scale: 0.97 };
const CARD_SHOWN = { opacity: 1, scale: 1 };
const CARD_EXIT = { opacity: 0, scale: 0.94, transition: { duration: 0.18 } };
// Tabs move like a carousel, the way the tab bar reads: Responses sits right
// of Questions, so going there pushes the page left and the new one follows it
// in from the right — both at once, on the same kind of spring (350ms, a touch
// of overshoot) as the tab bar's sliding pill. Variants, not inline objects, so
// the leaving page reads the new direction from AnimatePresence's `custom`.
const TAB_SLIDE = {
  enter: (/** @type {number} */ dir) => ({ x: `${100 * dir}%`, opacity: 0.6 }),
  shown: { x: 0, opacity: 1 },
  leave: (/** @type {number} */ dir) => ({ x: `${-100 * dir}%`, opacity: 0.6 }),
};
/** @type {import("motion/react").Transition} */
const TAB_SPRING = { type: "spring", duration: 0.35, bounce: 0.12 };
const ROW_ENTER = { opacity: 0, height: 0, y: -6 };
const ROW_SHOWN = { opacity: 1, height: "auto", y: 0 };
const ROW_EXIT = { opacity: 0, height: 0, transition: { duration: 0.16 } };

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
  return (
    <MotionConfig reducedMotion="user">
      <BuilderSession key={`${props.driveId}:${props.path}`} {...props} />
    </MotionConfig>
  );
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
  const source = useFileSource();
  const scope = fileSourceScope(source, driveId);
  const responsesKey = ["form-responses", scope, path];
  const solo = source.collab === false;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [doc, setDoc] = useState(/** @type {any} */ (null));
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
  /** Question ids in their order while a card is being dragged. */
  const [dragOrder, setDragOrderState] = useState(/** @type {string[] | null} */ (null));
  // Drag handlers read the live order, not the one from their render.
  const dragOrderRef = useRef(/** @type {string[] | null} */ (null));
  const setDragOrder = (next) => {
    dragOrderRef.current = next;
    setDragOrderState(next);
  };
  /** The question that was just added — its label takes focus. */
  const [focusNewId, setFocusNewId] = useState("");
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
        // Someone answered: refresh the Responses tab quietly.
        onFormResponse: () => {
          queryClient.invalidateQueries({ queryKey: ["form-responses", scope, path] });
          queryClient.invalidateQueries({ queryKey: ["form-response-count", scope, path] });
        },
      }),
  );
  syncRef.current = sync;

  const responsesQuery = useQuery({
    queryKey: responsesKey,
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
    /** @param {Uint8Array} _update @param {unknown} _origin @param {unknown} _doc @param {{ local?: boolean }} tr */
    const pull = (_update, _origin, _doc, tr) => {
      setDoc(readForm(sync.ydoc, { withIds: true }));
      // Only our own typing holds autosave back — a peer's edits must not
      // keep pushing our save later.
      if (tr?.local) lastEditRef.current = Date.now();
    };
    const onAware = () => {
      const localId = sync.ydoc.clientID;
      /** @type {{ id: string, name: string }[]} */
      const here = [];
      for (const [clientId, state] of sync.awareness.getStates()) {
        if (clientId === localId) continue;
        const id = state?.questionId;
        if (typeof id !== "string" || !id) continue;
        const peerName = state?.user?.name;
        here.push({ id, name: typeof peerName === "string" && peerName ? peerName : "Someone" });
      }
      setFocusHere(here);
    };
    sync.ydoc.on("update", pull);
    sync.awareness.on("update", onAware);
    sync.connect();

    (async () => {
      try {
        const text = typeof source.fetchText === "function"
          ? await source.fetchText(driveId, path)
          : await (async () => {
              const res = await source.fetch(source.contentHref(driveId, path));
              await requireOk(res, "Luna couldn't open this form.");
              return res.text();
            })();
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
        // Questions sharing an id would share every answer; give each its
        // own before anyone fills the form in again.
        if (canWrite) repairQuestionIds(sync.ydoc, newQuestionId);
        setDoc(readForm(sync.ydoc, { withIds: true }));
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
  }, [sync, driveId, path, source, canWrite]);

  const isDirty =
    canWrite && sync.hydrated && baseline != null && sync.serialize() !== baseline;
  // Both ways: undoing back to what's saved clears the unsaved mark.
  useEffect(() => {
    onSaveStateChange(isDirty);
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
    if (!canWrite) return undefined;
    return apply(sync.ydoc);
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
      setConfirm({ title, message, run: apply });
    } else {
      apply();
    }
  }

  function addQuestion(type) {
    const id = newQuestionId();
    edit((ydoc) => addFormQuestion(ydoc, {
      v: 1,
      id,
      type,
      label: "",
      required: false,
      config: defaultConfig(type),
    }));
    setFocusNewId(id);
  }

  function removeQuestion(question) {
    const run = () => {
      const removed = edit((ydoc) => removeFormQuestion(ydoc, question.id));
      if (!removed) return;
      addToast({
        type: "success",
        message: "Question removed",
        action: {
          label: "Undo",
          onClick: () => edit((ydoc) => addFormQuestion(ydoc, removed.question, removed.index)),
        },
      });
    };
    guardedChange(
      question.id,
      "Remove this question?",
      "People have already answered it. Their answers stay in the results — only the question goes away.",
      run,
    );
  }

  function changeType(question, type) {
    if (type === question.type) return;
    const keepsOptions = hasEditableOptions(question.type) && hasEditableOptions(type);
    guardedChange(
      question.id,
      "Change the question type?",
      "People have already answered this question. Their answers stay in the results, but may not match the new type.",
      () => edit((ydoc) => ydoc.transact(() => {
        // Choices ↔ checkboxes ↔ dropdown keep the options people wrote.
        if (keepsOptions) {
          patchFormQuestion(ydoc, question.id, { type });
          return;
        }
        patchFormQuestion(ydoc, question.id, {
          type,
          config: { options: null, allowOther: false, min: null, max: null },
        });
        const fresh = defaultConfig(type);
        if (Array.isArray(fresh.options)) setFormOptions(ydoc, question.id, fresh.options);
      })),
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
  const byId = new Map(questions.map((q) => [q.id, q]));
  const orderedIds = dragOrder
    ? dragOrder.filter((id) => byId.has(id))
    : questions.map((q) => q.id);
  const tabDirection = tab === "responses" ? 1 : -1;

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
                  className="-ml-1.5 flex h-6 w-6 items-center justify-center rounded-full surface-primary text-[0.65rem] ring-2 ring-primary first:ml-0"
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
        <p className="truncate border-b border-secondary/15 px-3 py-1 text-xs" role="status">
          {connNote}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loading || (!error && !doc) ? (
          <DocumentLoadingScreen label={`Opening ${name}`} />
        ) : error ? (
          <div className="p-4"><PageNotice variant="error">{error}</PageNotice></div>
        ) : (
          <AnimatePresence mode="popLayout" initial={false} custom={tabDirection}>
            <Motion.div
              key={tab}
              custom={tabDirection}
              variants={TAB_SLIDE}
              initial="enter"
              animate="shown"
              exit="leave"
              transition={TAB_SPRING}
              className="min-h-full"
            >
              {tab === "responses" ? (
                <FormResponses
                  driveId={driveId}
                  formPath={path}
                  questions={questions}
                  responses={responses}
                  loading={responsesQuery.isLoading}
                  error={responsesQuery.isError
                    ? apiErrorMessage(responsesQuery.error, "Luna couldn't load the answers. Try again.")
                    : null}
                  canDelete={canWrite}
                  onRefresh={() => queryClient.invalidateQueries({ queryKey: responsesKey })}
                  onDeleteResponse={async (id) => {
                    await source.deleteFormResponse(driveId, path, id);
                    queryClient.invalidateQueries({ queryKey: ["form-response-count", scope, path] });
                    await queryClient.invalidateQueries({ queryKey: responsesKey });
                  }}
                />
              ) : (
                <div className="mx-auto w-full max-w-2xl space-y-4 p-4 sm:p-6">
                  {/* Title + description edit inline — the builder is WYSIWYG, so
                      this reads like the responder's first screen. */}
                  <div className="rounded-large-element surface-secondary p-5 space-y-3">
                    <input
                      className="w-full bg-transparent font-mono text-xl font-normal text-primary outline-none no-focus-outline"
                      value={doc?.title || ""}
                      onChange={(e) => edit((ydoc) => setFormTitle(ydoc, e.target.value))}
                      placeholder="Form title"
                      aria-label="Form title"
                      disabled={!canWrite}
                    />
                    <AutoGrowTextarea
                      className="w-full resize-none bg-transparent text-sm text-primary outline-none no-focus-outline"
                      value={doc?.description || ""}
                      onChange={(value) => edit((ydoc) => setFormDescription(ydoc, value))}
                      placeholder="Say what this form is for (optional)"
                      aria-label="Form description"
                      disabled={!canWrite}
                    />
                  </div>

                  {questions.length === 0 ? (
                    <Motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="rounded-large-element border-2 border-dashed border-secondary/30 p-6 text-center"
                    >
                      <p className="font-mono text-sm text-secondary">No questions yet</p>
                      <p className="mt-1 text-sm text-secondary">
                        {canWrite
                          ? "Add your first question below. People see the form exactly as it looks here."
                          : "Nobody has added a question to this form yet."}
                      </p>
                    </Motion.div>
                  ) : null}

                  <Reorder.Group
                    as="div"
                    axis="y"
                    values={orderedIds}
                    onReorder={(next) => {
                      if (!dragOrderRef.current) return;
                      // A card swapped places under the finger.
                      haptic("selection");
                      setDragOrder(next);
                    }}
                    className="space-y-4"
                  >
                    <AnimatePresence initial={false}>
                      {orderedIds.map((id) => {
                        const question = byId.get(id);
                        if (!question) return null;
                        const index = questions.findIndex((q) => q.id === id);
                        return (
                          <QuestionItem
                            key={id}
                            question={question}
                            index={orderedIds.indexOf(id)}
                            count={questions.length}
                            canWrite={canWrite}
                            autoFocus={focusNewId === id}
                            onFocused={() => setFocusNewId("")}
                            responses={responses}
                            hasAnswers={answeredIds.has(id)}
                            earlier={questions.slice(0, index)}
                            watchers={focusHere.filter((p) => p.id === id)}
                            imageHref={question.image
                              ? source.formFileHref(driveId, path, question.image)
                              : ""}
                            onDragStart={() => {
                              haptic("rigid");
                              setDragOrder(questions.map((q) => q.id));
                            }}
                            onDragEnd={() => {
                              const finalOrder = dragOrderRef.current;
                              setDragOrder(null);
                              if (!finalOrder) return;
                              const to = finalOrder.indexOf(id);
                              if (to >= 0 && to !== index) {
                                haptic("medium");
                                moveQuestion(index, to);
                              }
                            }}
                            onFocus={() => focusQuestion(id)}
                            onBlur={() => focusQuestion("")}
                            onPickImage={() => setPickingImageFor(id)}
                            onPatch={(patch) => updateQuestion(id, patch)}
                            onChangeType={(type) => changeType(question, type)}
                            onRemove={() => removeQuestion(question)}
                            onMove={(to) => moveQuestion(index, to)}
                            onAddOption={() => edit((ydoc) => addFormOption(ydoc, id, ""))}
                            onSetOptionLabel={(optionId, label) =>
                              edit((ydoc) => setFormOptionLabel(ydoc, id, optionId, label))}
                            onRemoveOption={(optionId, label, picked) => {
                              const apply = () => edit((ydoc) => removeFormOption(ydoc, id, optionId));
                              if (picked) {
                                setConfirm({
                                  title: "Remove this option?",
                                  message: `Some answers picked “${label}”. Those answers stay in the results — the option just stops being offered.`,
                                  run: apply,
                                });
                              } else {
                                apply();
                              }
                            }}
                          />
                        );
                      })}
                    </AnimatePresence>
                  </Reorder.Group>

                  {canWrite && (
                    <Motion.div layout transition={SPRING} className="flex justify-center">
                      <AddQuestionButton onAdd={addQuestion} />
                    </Motion.div>
                  )}

                  <Motion.section
                    layout
                    transition={SPRING}
                    aria-labelledby="form-settings-title"
                    className="rounded-large-element surface-secondary p-3 space-y-3"
                  >
                    <h3
                      id="form-settings-title"
                      className="px-2 pt-1 font-mono text-base font-normal text-primary"
                    >
                      Settings
                    </h3>

                    <SettingsGroup title="Taking answers">
                      <Toggle
                        surface="primary"
                        label="Collecting answers"
                        description="Turn this off and the link stops taking new answers."
                        checked={settings.collecting !== false}
                        disabled={!canWrite}
                        onChange={(next) => setSetting("collecting", next)}
                      />
                      <SettingRow
                        htmlFor="form-close-on"
                        title="Stop taking answers after"
                        description="The form stays open through that day. Leave it empty to keep it open."
                      >
                        <FormInput
                          name="form-close-on"
                          type="date"
                          surface="primary"
                          value={settings.closeOn || ""}
                          onChange={(e) => setSetting("closeOn", e.target.value)}
                          disabled={!canWrite}
                          className="mb-0 w-48"
                        />
                      </SettingRow>
                      <SettingRow
                        htmlFor="form-max-responses"
                        title="Stop after this many answers"
                        description="Leave it empty for no limit. Changing an answer doesn't count as a new one."
                      >
                        <FormInput
                          name="form-max-responses"
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          surface="primary"
                          placeholder="No limit"
                          value={settings.maxResponses ?? ""}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setSetting("maxResponses", raw === "" ? null : Number(raw));
                          }}
                          disabled={!canWrite}
                          className="mb-0 w-36"
                        />
                      </SettingRow>
                    </SettingsGroup>

                    <SettingsGroup title="People answering">
                      <SettingRow
                        title="Answers per person"
                        description="Luna remembers each person in their browser, so this is a reminder rather than a lock."
                      >
                        <SegmentedControl
                          options={[
                            { value: "one", label: "One", disabled: !canWrite },
                            { value: "unlimited", label: "Unlimited", disabled: !canWrite },
                          ]}
                          value={settings.responseLimit === "one" ? "one" : "unlimited"}
                          onChange={(v) => setSetting("responseLimit", v === "one" ? "one" : "unlimited")}
                          surface="primary"
                          aria-label="Answers per person"
                        />
                      </SettingRow>
                      <Toggle
                        surface="primary"
                        label="Let people change their answers"
                        description="Each person gets a private edit link after sending."
                        checked={settings.allowEdits !== false}
                        disabled={!canWrite}
                        onChange={(next) => setSetting("allowEdits", next)}
                      />
                    </SettingsGroup>

                    <SettingsGroup title="After sending">
                      <div className="space-y-2">
                        <SettingRow
                          htmlFor="form-thank-you"
                          title="Thank-you message"
                          description={`People see this once they send. Leave it empty and Luna says “${DEFAULT_THANK_YOU}”`}
                        />
                        <AutoGrowTextarea
                          id="form-thank-you"
                          className="w-full resize-none rounded-large-element border-2 border-primary/30 surface-secondary px-5 py-2 text-base outline-none no-focus-outline focus:border-accent focus-visible:border-accent placeholder:text-primary/50"
                          value={settings.thankYou || ""}
                          onChange={(value) => setSetting("thankYou", value)}
                          placeholder={DEFAULT_THANK_YOU}
                          disabled={!canWrite}
                        />
                      </div>
                    </SettingsGroup>
                  </Motion.section>
                </div>
              )}
            </Motion.div>
          </AnimatePresence>
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
          formPath={path}
          startFolder={parentPath(path) ?? ""}
          onClose={() => setPickingImageFor(null)}
          onPicked={(pictureName) => {
            const id = pickingImageFor;
            setPickingImageFor(null);
            if (id) updateQuestion(id, { image: pictureName });
            addToast({ type: "success", message: "Picture added" });
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

/** A textarea that grows with what's typed, so nothing hides behind a scrollbar. */
function AutoGrowTextarea({ value, onChange, className, ...rest }) {
  const ref = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

AutoGrowTextarea.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  className: PropTypes.string,
};

const fieldClass =
  "rounded-pill border-2 border-secondary/30 surface-primary px-4 py-1.5 text-sm outline-none no-focus-outline focus:border-accent focus-visible:border-accent";

/** The control a person fills in — same shape as the answer page, not a grey stand-in. */
const previewFieldClass =
  "pointer-events-none w-full rounded-pill border-2 border-secondary/30 surface-primary px-4 py-2 text-base outline-none";

const answerPillClass =
  "flex items-center gap-3 rounded-pill border-2 border-secondary/30 surface-primary px-4 py-3 text-left text-base";

/**
 * A layer of related settings inside the settings card — the page-coloured
 * panel sits on the card so each group reads as its own surface.
 *
 * @param {{ title: string, children: import("react").ReactNode }} props
 */
function SettingsGroup({ title, children }) {
  return (
    <div className="rounded-large-element surface-primary p-4 space-y-4">
      <h4 className="font-mono text-sm font-normal text-secondary">{title}</h4>
      {children}
    </div>
  );
}

SettingsGroup.propTypes = {
  title: PropTypes.string.isRequired,
  children: PropTypes.node,
};

/**
 * One setting: the name and what it does on the left, its control on the
 * right — the same shape as a Toggle row, so every setting lines up. On a
 * narrow screen the control drops under the text.
 *
 * @param {{ title: string, description?: string, htmlFor?: string, children?: import("react").ReactNode }} props
 */
function SettingRow({ title, description, htmlFor, children }) {
  const Title = htmlFor ? "label" : "p";
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-56">
        <Title htmlFor={htmlFor} className="block text-sm font-medium text-secondary">
          {title}
        </Title>
        {description ? <p className="mt-0.5 text-sm">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

SettingRow.propTypes = {
  title: PropTypes.string.isRequired,
  description: PropTypes.string,
  htmlFor: PropTypes.string,
  children: PropTypes.node,
};

/**
 * One draggable question. Dragging starts from the grip only, so text in
 * the card stays selectable; the grip works with touch as well as a mouse.
 */
function QuestionItem(props) {
  const controls = useDragControls();
  // Reorder only lifts a card while its drag offset is non-zero, and the
  // offset passes through zero at every swap — so for a frame or two the
  // card would slip under its neighbour. Keep it on top until it lands.
  const [lifted, setLifted] = useState(false);
  return (
    <Reorder.Item
      as="div"
      value={props.question.id}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => {
        setLifted(true);
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}
      onDragTransitionEnd={() => setLifted(false)}
      // Only opacity and scale: the item's own y belongs to the drag. The list's
      // AnimatePresence skips this on first show, so switching tabs doesn't
      // replay it — only questions added afterwards grow in.
      initial={CARD_ENTER}
      animate={CARD_SHOWN}
      exit={CARD_EXIT}
      transition={SPRING}
      whileDrag={{ scale: 1.02 }}
      className={lifted ? "relative !z-20" : "relative"}
    >
      <QuestionCard {...props} dragControls={controls} />
    </Reorder.Item>
  );
}

QuestionItem.propTypes = {
  question: PropTypes.object.isRequired,
  onDragStart: PropTypes.func.isRequired,
  onDragEnd: PropTypes.func.isRequired,
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
  autoFocus,
  onFocused,
  responses,
  hasAnswers,
  dragControls,
  earlier = [],
  watchers = [],
  imageHref,
  onFocus,
  onBlur,
  onPickImage,
  onPatch,
  onChangeType,
  onRemove,
  onMove,
  onAddOption,
  onSetOptionLabel,
  onRemoveOption,
}) {
  const info = typeInfo(question.type);
  const labelRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const cardRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  // A question that was just added takes focus and scrolls into view once
  // its enter animation has started.
  useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => {
      labelRef.current?.focus({ preventScroll: true });
      cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      onFocused?.();
    }, 60);
    return () => clearTimeout(t);
  }, [autoFocus, onFocused]);

  // Option values people already picked — removing or renaming one of
  // those warns first; untouched ones just change.
  const pickedCounts = new Map();
  for (const r of responses) {
    const value = r?.answers?.[question.id];
    const picks = Array.isArray(value) ? value : value != null ? [value] : [];
    for (const pick of picks) {
      const key = String(pick);
      pickedCounts.set(key, (pickedCounts.get(key) || 0) + 1);
    }
  }

  function setBound(key, raw) {
    if (raw === "") {
      onPatch({ config: { [key]: null } });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    onPatch({ config: { [key]: n } });
  }

  const showOther = question.config?.allowOther === true;
  const watching = watcherLine(watchers);
  const labels = Array.isArray(question.config?.options) ? question.config.options : [];
  const ids = Array.isArray(question.config?.optionIds) ? question.config.optionIds : [];
  const options = labels.map((label, i) => ({ id: ids[i] || `i${i}`, label }));

  return (
    <div
      ref={cardRef}
      className="rounded-large-element surface-secondary p-5 space-y-3"
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="flex items-center gap-2">
        {canWrite && (
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              dragControls.start(e);
            }}
            className="-ml-1 flex h-8 w-6 touch-none cursor-grab items-center justify-center rounded-pill active:cursor-grabbing motion-safe:transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-accent no-focus-outline"
            aria-label={`Drag to reorder question ${index + 1}. You can also use the arrow buttons.`}
            title="Drag to reorder"
            tabIndex={-1}
          >
            <GripVertical size={ICON_SIZE.md} aria-hidden="true" />
          </button>
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
        <span className="font-mono text-xs font-normal">
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
          <span className="rounded-pill surface-primary px-3 py-1 font-mono text-xs font-normal">
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
        ref={labelRef}
        className="w-full bg-transparent text-base text-primary outline-none no-focus-outline"
        value={question.label || ""}
        onChange={(e) => onPatch({ label: e.target.value })}
        placeholder="Type the question"
        aria-label={`Question ${index + 1}`}
        disabled={!canWrite}
      />

      {/* The hint edits in place, where people will read it. */}
      {canWrite || question.help ? (
        <input
          className="-mt-1 w-full bg-transparent text-sm text-primary outline-none no-focus-outline"
          value={question.help || ""}
          onChange={(e) => onPatch({ help: e.target.value })}
          placeholder="Add a hint under the question (optional)"
          aria-label={`Hint for question ${index + 1}`}
          disabled={!canWrite}
        />
      ) : null}

      <AnimatePresence initial={false}>
        {question.image ? (
          <Motion.img
            key={question.image}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            src={imageHref}
            alt=""
            className="max-h-48 w-full rounded-large-element surface-primary object-contain"
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {watching ? (
          <Motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="text-xs"
          >
            {watching}
          </Motion.p>
        ) : null}
      </AnimatePresence>

      <QuestionFace
        question={question}
        options={options}
        canWrite={canWrite}
        showOther={showOther}
        pickedCounts={pickedCounts}
        onAddOption={onAddOption}
        onSetOptionLabel={onSetOptionLabel}
        onRemoveOption={onRemoveOption}
      />
      {/* What this kind of question collects — a caption on the answer
          preview, above the divider, so it isn't read as describing the
          editing buttons below. */}
      {info.hint ? <p className="-mt-1 text-xs">{info.hint}</p> : null}

      <div className="space-y-3 border-t border-primary/20 pt-3">
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
        {info.options && (
          <Toggle
            surface="secondary"
            label="Let people type their own answer"
            description="Adds an Other choice with a box to type in."
            checked={showOther}
            disabled={!canWrite}
            onChange={(next) => onPatch({ config: { allowOther: next } })}
          />
        )}
        {question.type === "number" && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm text-primary" htmlFor={`min-${question.id}`}>Smallest</label>
            <input
              id={`min-${question.id}`}
              type="number"
              className={cn(fieldClass, "w-32")}
              value={question.config?.min ?? ""}
              onChange={(e) => setBound("min", e.target.value)}
              placeholder="No minimum"
              disabled={!canWrite}
            />
            <label className="text-sm text-primary" htmlFor={`max-${question.id}`}>Largest</label>
            <input
              id={`max-${question.id}`}
              type="number"
              className={cn(fieldClass, "w-32")}
              value={question.config?.max ?? ""}
              onChange={(e) => setBound("max", e.target.value)}
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
            <span className="text-xs">People have answered this</span>
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
  autoFocus: PropTypes.bool,
  onFocused: PropTypes.func,
  responses: PropTypes.array.isRequired,
  hasAnswers: PropTypes.bool,
  dragControls: PropTypes.object.isRequired,
  earlier: PropTypes.array,
  watchers: PropTypes.array,
  imageHref: PropTypes.string,
  onFocus: PropTypes.func,
  onBlur: PropTypes.func,
  onPickImage: PropTypes.func,
  onPatch: PropTypes.func.isRequired,
  onChangeType: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
  onMove: PropTypes.func.isRequired,
  onAddOption: PropTypes.func.isRequired,
  onSetOptionLabel: PropTypes.func.isRequired,
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
 * The round mark in front of a choice — a dot for one pick, a tick box for many.
 * @param {{ multi?: boolean }} props
 */
function ChoiceMark({ multi = false }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-5 shrink-0 border-2 border-secondary/50",
        multi ? "rounded-md" : "rounded-full",
      )}
    />
  );
}

ChoiceMark.propTypes = { multi: PropTypes.bool };

/**
 * The face of a question — the same control the answer page shows.
 * Choice pills stay editable because those words are what people pick.
 * Dropdown options are edited as a list under the closed menu.
 */
function QuestionFace({
  question,
  options,
  canWrite,
  showOther,
  pickedCounts,
  onAddOption,
  onSetOptionLabel,
  onRemoveOption,
}) {
  if (hasEditableOptions(question.type)) {
    const dropdown = question.type === "dropdown";
    const multi = question.type === "multi_choice";
    return (
      <div className="flex flex-col gap-2">
        {dropdown ? (
          <div
            aria-hidden="true"
            className="inline-flex w-full items-center justify-between rounded-pill surface-primary px-4 py-2 font-mono text-sm font-normal"
          >
            Pick one…
            <ChevronDown size={ICON_SIZE.sm} aria-hidden="true" />
          </div>
        ) : null}
        {dropdown ? <p className="text-xs">Options in the list</p> : null}
        <OptionList
          options={options}
          canWrite={canWrite}
          pickedCounts={pickedCounts}
          mark={dropdown ? null : <ChoiceMark multi={multi} />}
          compact={dropdown}
          onSetOptionLabel={onSetOptionLabel}
          onRemoveOption={onRemoveOption}
        />
        <AnimatePresence initial={false}>
          {showOther && !dropdown ? (
            <Motion.div
              key="other"
              initial={ROW_ENTER}
              animate={ROW_SHOWN}
              exit={ROW_EXIT}
              transition={SPRING}
              className="overflow-hidden"
            >
              <div className={answerPillClass} aria-hidden="true">
                <ChoiceMark multi={multi} />
                Other: people type their own
              </div>
            </Motion.div>
          ) : null}
        </AnimatePresence>
        {canWrite && (
          <div>
            <Button variant="outline" surface="secondary" size="sm" onClick={onAddOption}>
              <Plus size={ICON_SIZE.sm} aria-hidden="true" />
              Add an option
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (question.type === "yes_no") {
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        {["Yes", "No"].map((option) => (
          <div key={option} className={answerPillClass}>
            <ChoiceMark />
            {option}
          </div>
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
        className={cn(previewFieldClass, "min-h-32 resize-none rounded-large-element")}
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
        className="inline-flex items-center gap-2 self-start rounded-pill border-2 border-primary px-4 py-2 text-sm text-primary"
      >
        <Upload size={ICON_SIZE.sm} aria-hidden="true" />
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
  pickedCounts: PropTypes.instanceOf(Map).isRequired,
  onAddOption: PropTypes.func.isRequired,
  onSetOptionLabel: PropTypes.func.isRequired,
  onRemoveOption: PropTypes.func.isRequired,
};

/**
 * Editable options, keyed by their stable ids so a new row slides in, a
 * removed one folds away, and focus stays on the row being typed in.
 */
function OptionList({ options, canWrite, pickedCounts, mark, compact, onSetOptionLabel, onRemoveOption }) {
  // Focus a row that appears after the first render (Add an option).
  const knownRef = useRef(new Set(options.map((o) => o.id)));
  const [focusId, setFocusId] = useState("");
  useEffect(() => {
    const fresh = options.find((o) => !knownRef.current.has(o.id));
    knownRef.current = new Set(options.map((o) => o.id));
    if (fresh) setFocusId(fresh.id);
  }, [options]);

  const counts = new Map();
  for (const o of options) {
    const key = o.label.trim();
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }

  return (
    <div className="flex flex-col">
      <AnimatePresence initial={false}>
        {options.map((option, optionIndex) => (
          <Motion.div
            key={option.id}
            layout="position"
            initial={ROW_ENTER}
            animate={ROW_SHOWN}
            exit={ROW_EXIT}
            transition={SPRING}
            className="overflow-hidden"
          >
            <OptionRow
              option={option}
              index={optionIndex}
              canWrite={canWrite}
              mark={mark}
              compact={compact}
              autoFocus={focusId === option.id}
              duplicate={(counts.get(option.label.trim()) || 0) > 1}
              pickedCounts={pickedCounts}
              onChange={(label) => onSetOptionLabel(option.id, label)}
              onRemove={(originalLabel) =>
                onRemoveOption(option.id, option.label, pickedCounts.has(originalLabel))}
            />
          </Motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

OptionList.propTypes = {
  options: PropTypes.array.isRequired,
  canWrite: PropTypes.bool,
  pickedCounts: PropTypes.instanceOf(Map).isRequired,
  mark: PropTypes.node,
  compact: PropTypes.bool,
  onSetOptionLabel: PropTypes.func.isRequired,
  onRemoveOption: PropTypes.func.isRequired,
};

function OptionRow({ option, index, canWrite, mark, compact, autoFocus, duplicate, pickedCounts, onChange, onRemove }) {
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  // The wording answers were stored under when the builder opened. Answers
  // keep that wording, so renaming a picked option says what happens.
  const [original] = useState(option.label);
  const picked = pickedCounts.get(original) || 0;
  const renamed = picked > 0 && option.label !== original;

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  return (
    <div className="pb-2">
      <div className="flex items-center gap-2">
        <div className={cn(compact ? "" : answerPillClass, "min-w-0 flex-1", compact ? "" : "py-0 pr-2")}>
          {mark}
          <input
            ref={inputRef}
            className={cn(
              compact
                ? cn(fieldClass, "w-full")
                : "min-w-0 flex-1 bg-transparent py-3 text-base text-secondary outline-none no-focus-outline",
            )}
            value={option.label}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Type an option"
            aria-label={`Option ${index + 1}`}
            aria-invalid={duplicate || undefined}
            disabled={!canWrite}
          />
        </div>
        {canWrite && (
          <Button
            variant="ghost"
            surface="secondary"
            size="iconSm"
            aria-label={`Remove option ${index + 1}`}
            tooltip="Remove this option"
            onClick={() => onRemove(original)}
          >
            <Trash2 size={ICON_SIZE.xs} aria-hidden="true" />
          </Button>
        )}
      </div>
      {duplicate ? (
        <p className="mt-1 px-4 text-xs">
          Another option says the same thing. People could only pick one of them — change one.
        </p>
      ) : !option.label.trim() && canWrite ? (
        <p className="mt-1 px-4 text-xs">Blank options are hidden from people answering.</p>
      ) : renamed ? (
        <p className="mt-1 px-4 text-xs">
          {picked === 1 ? "1 answer" : `${picked} answers`} picked “{original}”. Those stay under the old wording in the results.
        </p>
      ) : null}
    </div>
  );
}

OptionRow.propTypes = {
  option: PropTypes.shape({ id: PropTypes.string, label: PropTypes.string }).isRequired,
  index: PropTypes.number.isRequired,
  canWrite: PropTypes.bool,
  mark: PropTypes.node,
  compact: PropTypes.bool,
  autoFocus: PropTypes.bool,
  duplicate: PropTypes.bool,
  pickedCounts: PropTypes.instanceOf(Map).isRequired,
  onChange: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};

/**
 * Skip when an earlier answer matches. Only questions with a fixed set of
 * answers can be the trigger; yes/no stores yes/no, not the label.
 */
function SkipRow({ question, earlier, canWrite, onPatch }) {
  const logic = question.logic && typeof question.logic.questionId === "string"
    ? question.logic
    : null;
  const triggers = earlier.filter((q) => canTriggerSkip(q.type));
  const linked = logic ? earlier.find((q) => q.id === logic.questionId) || null : null;
  const trigger = linked && canTriggerSkip(linked.type) ? linked : null;

  function setLogic(questionId, equals) {
    if (!questionId) onPatch({ logic: null });
    else onPatch({ logic: { questionId, equals: equals == null ? "" : String(equals) } });
  }

  function defaultEquals(next) {
    if (!next) return "";
    if (next.type === "yes_no") return "yes";
    return answerOptions(next)[0] || "";
  }

  if (triggers.length === 0 && !logic) return null;

  const questionOptions = [
    { value: "", label: "Don't skip" },
    ...triggers.map((q) => ({
      value: q.id,
      label: q.label || `Question ${earlier.indexOf(q) + 1}`,
    })),
  ];
  const equalsOptions = trigger?.type === "yes_no"
    ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]
    : answerOptions(trigger).map((option) => ({ value: option, label: option }));
  const equalsValue = trigger?.type === "yes_no"
    ? (logic?.equals === "no" ? "no" : "yes")
    : (logic?.equals || "");
  // The picked answer was renamed or removed on the other question.
  const staleAnswer = trigger && trigger.type !== "yes_no" && !equalsOptions.some((o) => o.value === equalsValue);
  // The other question changed to a type that can't trigger a skip.
  const staleTrigger = logic && linked && !trigger;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-primary">Skip this question when</span>
        <Dropdown
          options={questionOptions}
          value={trigger ? trigger.id : ""}
          disabled={!canWrite}
          bg="primary"
          aria-label="Skip when this earlier question"
          onChange={(id) => {
            const next = triggers.find((q) => q.id === id) || null;
            setLogic(id, defaultEquals(next));
          }}
        />
        {trigger && (
          <>
            <span className="text-sm text-primary">is</span>
            <Dropdown
              options={equalsOptions}
              value={equalsValue}
              placeholder="Pick an answer"
              disabled={!canWrite}
              bg="primary"
              aria-label="Skip when the answer is"
              onChange={(value) => setLogic(trigger.id, value)}
            />
          </>
        )}
      </div>
      {staleAnswer ? (
        <p className="text-xs">
          The answer this skip used is no longer on that question, so it never skips. Pick another answer.
        </p>
      ) : staleTrigger ? (
        <p className="text-xs">
          That question can&apos;t decide a skip anymore — its type changed. Pick another question or choose Don&apos;t skip.
        </p>
      ) : null}
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
 * Pick a picture already on Luna, or upload one from this device. Either
 * way Luna copies it next to the form, so the answer link can show it
 * without opening anything else on the drive.
 */
function PicturePicker({ driveId, formPath, startFolder, onPicked, onClose }) {
  const source = useFileSource();
  const [folder, setFolder] = useState(startFolder);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const uploadRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const listing = useQuery({
    queryKey: ["form-pictures", fileSourceScope(source, driveId), folder],
    queryFn: () => source.listDir(driveId, folder),
  });
  const entries = (Array.isArray(listing.data) ? listing.data : [])
    .filter((entry) => entry && !entry.hidden)
    .filter((entry) => entry.kind === "dir" || isImageFileName(entry.name));
  const folders = entries.filter((e) => e.kind === "dir");
  const pictures = entries.filter((e) => e.kind !== "dir");

  async function run(task) {
    setSaving(true);
    setSaveError("");
    try {
      const pictureName = await task();
      if (!pictureName) throw new Error("Luna didn't keep that picture. Try again.");
      onPicked(pictureName);
    } catch (err) {
      setSaveError(apiErrorMessage(err, "Luna couldn't add that picture. Try another one."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalCard
      open
      title="Choose a picture"
      onClose={onClose}
      overlayClassName={NESTED_OVERLAY_CLASS}
    >
      <div className="space-y-3">
        <p className="text-sm text-primary">
          Choose a picture already on Luna, or upload a JPG, PNG, GIF, or WebP (up to 20 MB).
          Luna keeps a copy next to the form so people answering can see it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 truncate font-mono text-xs font-normal text-primary">
            {folder || "Top folder"}
          </p>
          {folder ? (
            <Button
              variant="ghost"
              surface="secondary"
              size="sm"
              disabled={saving}
              onClick={() => setFolder(parentPath(folder) ?? "")}
            >
              <CornerLeftUp size={ICON_SIZE.sm} aria-hidden="true" />
              Up
            </Button>
          ) : null}
          <Button
            variant="outline"
            surface="secondary"
            size="sm"
            disabled={saving}
            onClick={() => uploadRef.current?.click()}
          >
            <Upload size={ICON_SIZE.sm} aria-hidden="true" />
            Upload from this device
          </Button>
          <input
            ref={uploadRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) run(() => source.uploadFormPicture(driveId, formPath, file));
            }}
          />
        </div>
        <ModalErrorNotice error={saveError} />
        {saving ? (
          <div className="flex items-center gap-2" role="status">
            <Spinner size="sm" decorative />
            <span className="text-sm text-primary">Adding the picture</span>
          </div>
        ) : listing.isError ? (
          <PageNotice variant="error">Luna couldn&apos;t open that folder. Go up a folder or try again.</PageNotice>
        ) : listing.isLoading ? (
          <div className="flex items-center gap-2" role="status">
            <Spinner size="sm" decorative />
            <span className="text-sm text-primary">Opening</span>
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-primary">No pictures in this folder. Open another one or upload a picture.</p>
        ) : (
          <div className="max-h-80 space-y-3 overflow-y-auto no-scrollbar">
            {folders.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {folders.map((entry) => (
                  <Button
                    key={entry.name}
                    variant="outline"
                    surface="secondary"
                    size="sm"
                    haptic="selection"
                    onClick={() => setFolder(joinPath(folder, entry.name))}
                  >
                    <Folder size={ICON_SIZE.sm} aria-hidden="true" />
                    {entry.name}
                  </Button>
                ))}
              </div>
            )}
            {pictures.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {pictures.map((entry, i) => {
                  const picturePath = joinPath(folder, entry.name);
                  return (
                    <Motion.button
                      key={entry.name}
                      type="button"
                      initial={{ opacity: 0, scale: 0.94 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: Math.min(i * 0.02, 0.3) }}
                      whileHover={{ scale: 1.03 }}
                      whileTap={{ scale: 0.97 }}
                      className="group relative aspect-square overflow-hidden rounded-large-element surface-primary focus-visible:ring-2 focus-visible:ring-accent no-focus-outline"
                      aria-label={`Use ${entry.name}`}
                      title={entry.name}
                      onClick={() => {
                        haptic("selection");
                        run(() => source.copyFormPicture(driveId, formPath, picturePath));
                      }}
                    >
                      <img
                        src={source.contentHref(driveId, picturePath)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </Motion.button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </ModalCard>
  );
}

PicturePicker.propTypes = {
  driveId: PropTypes.string.isRequired,
  formPath: PropTypes.string.isRequired,
  startFolder: PropTypes.string.isRequired,
  onPicked: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

/** "+ Add a question" — the shared dropdown menu with an accent trigger. */
function AddQuestionButton({ onAdd }) {
  return (
    <Dropdown
      options={TYPE_OPTIONS}
      value=""
      onChange={(type) => onAdd(type)}
      aria-label="Add a question"
      renderTrigger={({ open, toggle, onKeyDown }) => (
        <Button
          variant="secondary"
          surface="primary"
          haptic={false}
          onClick={toggle}
          onKeyDown={onKeyDown}
          aria-expanded={open}
          aria-haspopup="listbox"
        >
          <Plus
            size={ICON_SIZE.sm}
            aria-hidden="true"
            className={cn("motion-safe:transition-transform motion-safe:duration-300", open && "rotate-45")}
          />
          Add a question
        </Button>
      )}
    />
  );
}

AddQuestionButton.propTypes = {
  onAdd: PropTypes.func.isRequired,
};
