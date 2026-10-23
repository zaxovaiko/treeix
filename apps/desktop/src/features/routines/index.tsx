import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { reposOf } from "../../dialogs";
import type { Routine, RoutineRun, RunStatus } from "../../ipc/api";
import { Icon } from "../../lib/icons";
import type { Command } from "../../lib/paletteSearch";
import {
  showSettingsSection,
} from "../../pages/settings/nav";
import { Group, Row, Seg, Switch } from "../../pages/settings/controls";
import type { SectionProps } from "../../pages/settings/sections";
import { Ki, type Dot } from "../../shell/model";
import type { ShellView } from "../../shell/Shell";
import { leaves, newTabId, type Tab } from "../../shell/state";
import { useSettings } from "../agents/settings";
import { Editor } from "./Editor";
import {
  CAUSE,
  lastRunText,
  newRoutine,
  runCost,
  STATUS,
  TEMPLATES,
  whenLabel,
  whenText,
  whereText,
} from "./logic";
import { routinesNow, useRoutines } from "./store";
import { toast, Toasts } from "./toasts";
import "../../styles/routines.css";

const AGENT = { claude: "Claude", codex: "Codex" } as const;
const LIVE = new Set<RunStatus>(["queued", "running"]);
const RECENT_RUNS = 15;

let editing: { routine: Routine; seq: number } | null = null;
const editListeners = new Set<() => void>();
const subscribeEditing = (l: () => void) => (
  editListeners.add(l),
  () => void editListeners.delete(l)
);

/** Opens the editor on a routine, a template or a new draft (empty id); null closes it */
export function editRoutine(routine: Routine | null) {
  editing = routine && { routine, seq: (editing?.seq ?? 0) + 1 };
  editListeners.forEach((l) => l());
}

const draftFor = (view: ShellView) =>
  newRoutine(reposOf(view)[0]?.path ?? null);
const editById = (id: string) => {
  const routine = routinesNow().routines?.find((r) => r.id === id);
  if (routine) editRoutine(routine);
  else toast({ icon: "clock", title: "That routine was deleted" });
};

/** Settings > Routines, opening the Settings tab when it is closed */
function showRoutines(view: ShellView) {
  showSettingsSection("routines");
  view.run("settings");
}

/** The run's session in a tab, or History once it has ended */
function openRun(view: ShellView, run: RoutineRun) {
  const session = run.session;
  if (!session || !view.sessions[session])
    return view.dispatch({ type: "set", patch: { panel: "history" } });
  const tab = view.ordered.find((t) => leaves(t.root).includes(session));
  view.dispatch(
    tab
      ? { type: "activate", tabId: tab.id }
      : { type: "open", session, tabId: newTabId() },
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Toasts for what a run did while nobody watched: started, waiting for a slot, did not start, stopped */
function runToast(view: ShellView, run: RoutineRun) {
  const routine = routinesNow().routines?.find((r) => r.id === run.routine);
  const agent = routine?.agent ?? "claude";
  const edit: [string, () => void] = [
    "Edit routine",
    () => editById(run.routine),
  ];
  const open: [string, () => void] = ["Open", () => openRun(view, run)];
  switch (run.status) {
    case "running":
      return toast({
        icon: agent,
        title: `${run.name} started ${AGENT[agent]}`,
        body: run.detail ?? run.cwd ?? undefined,
        actions: [open],
      });
    case "queued":
      return toast({
        icon: "clock",
        title: `${run.name} is waiting`,
        body: "Other routine runs are going. It starts when one finishes.",
      });
    case "skipped":
      return toast({
        icon: "clock",
        title: `${run.name} skipped a run`,
        body: run.error ?? undefined,
        actions: [edit],
      });
    case "failed":
      return run.startedAt === null
        ? toast({
            icon: agent,
            title: `${run.name} did not start`,
            body: run.error ?? undefined,
            actions: [edit],
          })
        : toast({
            icon: agent,
            title: `${run.name} failed`,
            body: run.error ?? undefined,
            actions: [open, edit],
          });
    case "overBudget":
      return toast({
        icon: agent,
        title: `${run.name} stopped`,
        body: run.error ?? undefined,
        actions: [open, edit],
      });
  }
}

function Host({ view }: { view: ShellView }) {
  const open = useSyncExternalStore(subscribeEditing, () => editing);
  // Keeps the store loaded for the palette and the clock tags
  useRoutines(view.api);
  const seen = useRef(new Map<string, RunStatus>());
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(
    () =>
      view.api.onRoutines((e) => {
        if (e.type !== "run" || seen.current.get(e.run.id) === e.run.status)
          return;
        seen.current.set(e.run.id, e.run.status);
        runToast(viewRef.current, e.run);
      }),
    [view.api],
  );
  return createPortal(
    <>
      <Toasts />
      {open && (
        <Editor
          key={open.seq}
          view={view}
          initial={open.routine}
          onClose={() => editRoutine(null)}
        />
      )}
    </>,
    document.body,
  );
}

/** The editor and the toasts; mounted once per window, nothing while the feature is off */
export function RoutinesHost({ view }: { view: ShellView }) {
  return useSettings(view.api)?.features.routines ? <Host view={view} /> : null;
}

function Clock({ view, id }: { view: ShellView; id: string }) {
  const name = useRoutines(view.api).routines?.find((r) => r.id === id)?.name;
  return (
    <span
      className="rtc"
      title={`Started by the routine ${name ?? "that was deleted"}. Click to edit it`}
      onClick={(e) => {
        e.stopPropagation();
        editById(id);
      }}
    >
      <Icon name="clock" />
    </span>
  );
}

/** The clock on a tab a routine run started */
export function RoutineClock({ view, tab }: { view: ShellView; tab: Tab }) {
  const id = leaves(tab.root)
    .map((s) => view.sessions[s]?.routine)
    .find(Boolean);
  return id ? <Clock view={view} id={id} /> : null;
}

function RunMarkName({ view, run }: { view: ShellView; run: string }) {
  const name = useRoutines(view.api).runs.find((r) => r.id === run)?.name;
  return (
    <span
      className="rtc"
      title={name ? `Started by the routine ${name}` : "Started by a routine"}
    >
      <Icon name="clock" />
    </span>
  );
}

/** History: the clock on a session a routine run started */
export const RunMark = ({
  view,
  run,
}: {
  view: ShellView;
  run: string | null | undefined;
}) => (run ? <RunMarkName view={view} run={run} /> : null);

const runDot = (run: RoutineRun | undefined): Dot =>
  !run
    ? "idle"
    : LIVE.has(run.status)
      ? "run"
      : run.status === "failed" || run.status === "overBudget"
        ? "err"
        : "idle";

function RoutineRow({
  view,
  routine: r,
  last,
  onError,
}: {
  view: ShellView;
  routine: Routine;
  last: RoutineRun | undefined;
  onError: (e: unknown) => void;
}) {
  const { api } = view;
  const [next, setNext] = useState<number | null>(null);
  const cron = r.trigger.kind === "schedule" ? r.trigger.cron : null;
  useEffect(() => {
    if (!cron || !r.enabled) return setNext(null);
    let live = true;
    api.routineNextFires(cron, 1).then(
      (at) => live && setNext(at[0] ?? null),
      () => live && setNext(null),
    );
    return () => void (live = false);
  }, [api, cron, r.enabled]);
  const [text, tone] = lastRunText(last);
  const live = last && LIVE.has(last.status);
  const isEvent = r.trigger.kind === "event";
  return (
    <div className={`srow rtrow ${r.enabled ? "" : "off"}`}>
      <Ki kind={r.agent} dot={runDot(last)} />
      <div className="grow">
        <div className="sl trunc">{r.name}</div>
        <div className="sd">
          {whenText(r)} · {whereText(r)}
        </div>
        <div className="sd">
          {!r.enabled && "Off · "}
          <span className={tone}>{text}</span>
          {r.enabled && !live && next !== null && ` · Next ${whenLabel(next)}`}
        </div>
      </div>
      <div className="sc">
        {last?.session && (
          <button
            className="btn sm"
            onClick={() => openRun(view, last)}
          >
            Open
          </button>
        )}
        <button
          className="icon sm"
          disabled={isEvent}
          title={isEvent ? "Runs when the event happens" : "Run now"}
          onClick={() => api.routineRunNow(r.id).catch(onError)}
        >
          <Icon name="play" />
        </button>
        <button className="btn sm" onClick={() => editRoutine(r)}>
          Edit
        </button>
        <Switch
          label={`${r.name} on`}
          on={r.enabled}
          onChange={(enabled) =>
            void api.routinePut({ ...r, enabled }).catch(onError)
          }
        />
      </div>
    </div>
  );
}

function RunRow({
  view,
  run,
  agent,
  onError,
}: {
  view: ShellView;
  run: RoutineRun;
  agent: Routine["agent"];
  onError: (e: unknown) => void;
}) {
  const [label, tone] = STATUS[run.status];
  const cost = runCost(run);
  const pr = run.pr;
  return (
    <div className="srow rtrun">
      <Ki kind={agent} dot={runDot(run)} sm />
      <div className="grow">
        <div className="sl trunc">
          {run.name}
          {run.detail && <span className="dim"> · {run.detail}</span>}
        </div>
        <div className="sd">
          <span className={tone}>{label}</span>
          {run.error && run.status !== "cancelled" && `: ${run.error}`} ·{" "}
          {CAUSE[run.cause]} · {whenLabel(run.startedAt ?? run.dueAt)}
          {cost && ` · ${cost}`}
        </div>
        {run.summary && (
          <div className="sd trunc" title={run.summary}>
            {run.summary.trim().split("\n")[0]}
          </div>
        )}
      </div>
      <div className="sc">
        {pr && (
          <button
            className="btn sm"
            title={pr.url}
            onClick={() => void view.api.openUrl(pr.url)}
          >
            PR #{pr.number}
          </button>
        )}
        {LIVE.has(run.status) && (
          <button
            className="btn sm"
            onClick={() => view.api.routineCancelRun(run.id).catch(onError)}
          >
            {run.status === "queued" ? "Drop" : "Stop"}
          </button>
        )}
        {run.session && (
          <button
            className="btn sm"
            onClick={() => openRun(view, run)}
          >
            Open
          </button>
        )}
      </div>
    </div>
  );
}

/** Settings > Routines: the list, templates when empty, the editor and "While Treeix is closed" */
export function RoutinesSection({ view, settings, update }: SectionProps) {
  const { routines, runs, error: loadError } = useRoutines(view.api);
  const [error, setError] = useState<string | null>(null);
  const onError = (e: unknown) => setError(message(e));
  const agentOf = (id: string) =>
    routines?.find((r) => r.id === id)?.agent ?? "claude";
  const recent = runs.slice(0, RECENT_RUNS);
  const shownError = error ?? loadError;
  return (
    <>
      <Group>
        <Row
          label=""
          wide
          keywords="routines schedule cron event webhook run review ci ticket template"
          desc={
            <>
              A routine starts a Claude or Codex session on this Mac on a
              schedule or when something happens. Each run is a normal tab in
              its place, marked with <Icon name="clock" className="rtinline" />
            </>
          }
        >
          <div className="rtlist">
            {shownError && <div className="sd st-err">{shownError}</div>}
            {routines === null ? null : routines.length ? (
              routines.map((r) => (
                <RoutineRow
                  key={r.id}
                  view={view}
                  routine={r}
                  last={runs.find((x) => x.routine === r.id)}
                  onError={onError}
                />
              ))
            ) : (
              <>
                <div className="sd rtintro">
                  No routines yet. Start from one of these:
                </div>
                {TEMPLATES.map((t) => {
                  const draft = { ...draftFor(view), ...t };
                  return (
                    <button
                      key={t.name}
                      className="srow rttpl"
                      onClick={() => editRoutine(draft)}
                    >
                      <Ki kind={draft.agent} />
                      <div className="grow">
                        <div className="sl">{t.name}</div>
                        <div className="sd">{whenText(draft)}</div>
                      </div>
                      <Icon name="plus" />
                    </button>
                  );
                })}
              </>
            )}
            <div className="rtnew">
              <button
                className="btn sm"
                onClick={() => editRoutine(draftFor(view))}
              >
                <Icon name="plus" />
                New routine
              </button>
            </div>
          </div>
        </Row>
      </Group>
      {recent.length > 0 && (
        <Group title="Recent runs">
          <Row
            label=""
            wide
            keywords="runs history status failed budget skipped asleep"
          >
            <div className="rtlist">
              {recent.map((run) => (
                <RunRow
                  key={run.id}
                  view={view}
                  run={run}
                  agent={agentOf(run.routine)}
                  onError={onError}
                />
              ))}
            </div>
          </Row>
        </Group>
      )}
      <Group title="While Treeix is closed">
        <Row
          label="Run routines when Treeix is closed"
          desc="The PTY host keeps running and fires them. Runs wait as tabs for when you open Treeix"
          keywords="background"
        >
          <Switch
            label="Run routines when Treeix is closed"
            on={settings.routines.background}
            onChange={(background) => update({ routines: { background } })}
          />
        </Row>
        <Row
          label="Runs at the same time"
          desc="More wait until one finishes"
          keywords="parallel queue"
        >
          <Seg
            value={settings.routines.maxParallel}
            options={[
              [1, "1"],
              [2, "2"],
              [3, "3"],
            ]}
            onChange={(maxParallel) => update({ routines: { maxParallel } })}
          />
        </Row>
      </Group>
    </>
  );
}

/** "Routines", "New routine..." and "Run routine: <name>"; only asked while the feature is on */
export function routineCommands(view: ShellView): Command[] {
  const runnable = (routinesNow().routines ?? []).filter(
    (r) => r.enabled && r.trigger.kind !== "event",
  );
  return [
    {
      id: "routines",
      group: "Actions",
      label: "Routines",
      icon: "clock",
      run: () => showRoutines(view),
    },
    {
      id: "routine-new",
      group: "Actions",
      label: "New routine...",
      icon: "clock",
      run: () => editRoutine(draftFor(view)),
    },
    ...runnable.map((r): Command => ({
      id: `routine-run-${r.id}`,
      group: "Actions",
      label: `Run routine: ${r.name}`,
      icon: "clock",
      run: () =>
        void view.api
          .routineRunNow(r.id)
          .catch((e: unknown) =>
            toast({
              icon: "clock",
              title: `${r.name} did not start`,
              body: message(e),
            }),
          ),
    })),
  ];
}
