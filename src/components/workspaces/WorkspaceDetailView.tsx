import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  Check,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Play,
  Settings,
  Trash2,
  X,
} from "lucide-react";

import {
  approveWorkspaceTask,
  attachWorkspaceAddon,
  createWorkspaceTask,
  detectWorkspaceEngines,
  detachWorkspaceAddon,
  getContextSources,
  getLatestWorkspaceRun,
  getSetupStatus,
  getWorkspaceTaskStaffing,
  listWorkspaceAddons,
  openWorkspaceArtifact,
  previewTaskGrounding,
  rejectWorkspaceTask,
  revealWorkspaceArtifact,
  runWorkspaceTask,
  setWorkspaceTaskAgentEligible,
  setWorkspaceEngine,
  setWorkspaceInstructions,
  setWorkspaceModel,
  setWorkspaceNetworkAllowed,
  stopWorkspaceRun,
  suggestTaskCapability,
} from "../../lib/tauri";
import type {
  ContextSources,
  ModelProfile,
  TaskGroundingPreview,
  TaskStaffing,
  WorkspaceAddon,
  WorkspaceArtifact,
  WorkspaceContextItem,
  WorkspaceDetail,
  WorkspaceEngine,
  WorkspaceRun,
  WorkspaceTask,
} from "../../types";
import { ArtifactPreview } from "./ArtifactPreview";
import { engineLabel } from "./engineLabel";

type TaskCapability = "research" | "write" | "visualize" | "present";

const CAPABILITY_OPTIONS: ReadonlyArray<{
  value: TaskCapability;
  label: string;
  adapterSlugs: readonly string[];
}> = [
  { value: "research", label: "Research", adapterSlugs: ["deep-research"] },
  {
    value: "write",
    label: "Write",
    adapterSlugs: [
      "meeting-grounded-writing",
      "architecture-doc",
      "marketing-copy",
    ],
  },
  { value: "visualize", label: "Visualize", adapterSlugs: ["drawio-diagram"] },
  { value: "present", label: "Present", adapterSlugs: ["slides-deck"] },
];

const BASELINE_HINTS: Record<TaskCapability, string> = {
  research: "Runs as a Markdown report with sources.",
  write: "Runs as a Markdown document.",
  visualize: "Runs as HTML/SVG baseline, exports PNG and SVG.",
  present: "Runs as HTML slides baseline.",
};

const CAPABILITY_BADGE_COLORS: Record<
  TaskCapability,
  { background: string; color: string }
> = {
  research: { background: "rgba(0,122,255,0.12)", color: "#8ec5ff" },
  write: { background: "rgba(175,82,222,0.12)", color: "#e1b3ff" },
  visualize: { background: "rgba(52,199,89,0.12)", color: "#b7ffc6" },
  present: { background: "rgba(255,149,0,0.12)", color: "#ffd19a" },
};

function installedAdapter(
  capability: (typeof CAPABILITY_OPTIONS)[number],
  catalog: WorkspaceAddon[],
): WorkspaceAddon | undefined {
  return catalog.find(
    (addon) =>
      addon.kind === "skill" && capability.adapterSlugs.includes(addon.slug),
  );
}

function CapabilityBadge({ capability }: { capability: string }) {
  const option = CAPABILITY_OPTIONS.find((item) => item.value === capability);
  const label = option?.label ?? (capability.trim() || "Task");
  const colors = option
    ? CAPABILITY_BADGE_COLORS[option.value]
    : { background: "var(--overlay-5)", color: "var(--text-secondary)" };
  return (
    <span
      className="badge-tag ws-task-capability"
      style={{
        background: colors.background,
        color: colors.color,
      }}
    >
      {label}
    </span>
  );
}

function TaskStaffingLine({
  task,
  staffing,
  catalog,
  engine,
}: {
  task: WorkspaceTask;
  staffing: TaskStaffing | null | undefined;
  catalog: WorkspaceAddon[];
  engine: string;
}) {
  const baselinePrefix = "baseline:";
  if (staffing?.reason.startsWith(baselinePrefix)) {
    const capability = staffing.reason.slice(baselinePrefix.length) || task.capability;
    return (
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: "12px",
          margin: "6px 0 0",
        }}
      >
        Baseline {capability} · {engineLabel(engine)}
      </p>
    );
  }

  const skillId = staffing?.skill_ids[0];
  const skill =
    skillId === undefined
      ? undefined
      : catalog.find((addon) => addon.id === skillId);
  if (!skill) return null;

  return (
    <p
      style={{
        color: "var(--text-muted)",
        fontSize: "12px",
        margin: "6px 0 0",
      }}
    >
      Runs as {skill.name} · {engineLabel(engine)}
    </p>
  );
}

interface WorkspaceDetailViewProps {
  detail: WorkspaceDetail;
  error: string | null;
  onBack: () => void;
  onOpenMeeting: (meetingId: number) => void;
  onAddTask: (title: string) => Promise<boolean>;
  onDeleteTask: (taskId: number) => Promise<void>;
  onAddFolder: () => Promise<void>;
  onRemoveContext: (itemId: number) => Promise<void>;
  onRefresh: () => Promise<void>;
}

interface ActiveRun {
  taskId: number;
  engine: string;
  pending: boolean;
  run: WorkspaceRun | null;
  log: string;
  error: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function engineCaption(engine: string): string {
  if (engine === "local") return "Drafts documents from meeting context.";
  return "Full agent: reads folders, writes files.";
}

function elapsedRunTime(run: WorkspaceRun | null, now: number): string {
  if (!run) return "0m 00s";
  const started = new Date(run.started_at).getTime();
  if (!Number.isFinite(started) || now < started) return "0m 00s";
  const totalSeconds = Math.floor((now - started) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}m ${seconds}s`;
}

function contextIcon(item: WorkspaceContextItem) {
  if (item.kind === "folder") return <Folder size={15} aria-hidden="true" />;
  if (item.kind === "meeting") {
    return <CalendarDays size={15} aria-hidden="true" />;
  }
  return <FileText size={15} aria-hidden="true" />;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function WorkspaceDetailView({
  detail,
  error,
  onBack,
  onOpenMeeting,
  onDeleteTask,
  onAddFolder,
  onRemoveContext,
  onRefresh,
}: WorkspaceDetailViewProps) {
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDetails, setTaskDetails] = useState("");
  const [taskCapability, setTaskCapability] = useState<TaskCapability | null>(null);
  const [suggestedCapability, setSuggestedCapability] =
    useState<TaskCapability | null>(null);
  const [capabilityPickedManually, setCapabilityPickedManually] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [catalog, setCatalog] = useState<WorkspaceAddon[]>([]);
  const [taskStaffing, setTaskStaffing] = useState<
    Record<number, TaskStaffing | null>
  >({});
  const [engines, setEngines] = useState<WorkspaceEngine[]>([]);
  const [installedModels, setInstalledModels] = useState<ModelProfile[]>([]);
  const [engineBusy, setEngineBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [polledRuns, setPolledRuns] = useState<Record<number, WorkspaceRun>>({});
  const [latestRuns, setLatestRuns] = useState<Record<number, WorkspaceRun>>({});
  const [expandedArtifacts, setExpandedArtifacts] = useState<Set<number>>(
    () => new Set(),
  );
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [rejectingTaskId, setRejectingTaskId] = useState<number | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [verdictTaskId, setVerdictTaskId] = useState<number | null>(null);
  const [eligibilityTaskId, setEligibilityTaskId] = useState<number | null>(null);
  const [contextSources, setContextSources] = useState<ContextSources>({
    vault_path: "",
    projects_root: "",
  });
  const [groundingPreview, setGroundingPreview] =
    useState<TaskGroundingPreview | null>(null);
  const [groundingPreviewLoading, setGroundingPreviewLoading] = useState(false);
  const groundingPreviewVersion = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState(
    detail.workspace.instructions,
  );
  const [savedInstructions, setSavedInstructions] = useState(
    detail.workspace.instructions,
  );
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [instructionsError, setInstructionsError] = useState<string | null>(
    null,
  );
  const [pendingAddonId, setPendingAddonId] = useState<number | null>(null);
  const [updatingNetwork, setUpdatingNetwork] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [runClock, setRunClock] = useState(() => Date.now());

  const awaitingTasks = detail.tasks.filter(
    (task) => task.status === "awaiting_review",
  );
  const runningTasks = detail.tasks.filter((task) => task.status === "running");
  const queuedTasks = detail.tasks.filter(
    (task) => task.status === "queued" || task.status === "failed",
  );
  const doneTasks = detail.tasks.filter((task) => task.status === "done");
  const meetingCount = detail.context_items.filter(
    (item) => item.kind === "meeting",
  ).length;
  const folderCount = detail.context_items.filter(
    (item) => item.kind === "folder",
  ).length;
  const folderContextItems = detail.context_items.filter(
    (item) => item.kind === "folder",
  );
  const attachedSkills = detail.addons.filter(
    (addon) => addon.kind === "skill",
  );
  const attachedSkillIds = new Set(attachedSkills.map((addon) => addon.id));
  const catalogSkills = catalog.filter((addon) => addon.kind === "skill");
  const instructionsChanged = instructionsDraft !== savedInstructions;
  const reviewRunIds = new Set(
    Object.values(latestRuns).map((run) => run.id),
  );
  const remainingArtifacts = detail.artifacts.filter(
    (artifact) => !reviewRunIds.has(artifact.run_id),
  );
  const pollingTaskKey = runningTasks
    .filter((task) => activeRun?.taskId !== task.id)
    .map((task) => task.id)
    .sort((a, b) => a - b)
    .join(",");

  useEffect(() => {
    setInstructionsDraft(detail.workspace.instructions);
    setSavedInstructions(detail.workspace.instructions);
    setInstructionsSaved(false);
    setInstructionsError(null);
  }, [detail.workspace.id, detail.workspace.instructions]);

  useEffect(() => {
    setExpandedTaskIds(new Set());
    setRejectingTaskId(null);
    setRejectionReason("");
  }, [detail.workspace.id]);

  useEffect(() => {
    const hasActiveRun =
      runningTasks.length > 0 || activeRun?.pending === true;
    if (!hasActiveRun) return;
    setRunClock(Date.now());
    const interval = window.setInterval(() => setRunClock(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [activeRun?.pending, runningTasks.length]);

  useEffect(() => {
    let cancelled = false;
    void detectWorkspaceEngines()
      .then((detected) => {
        if (!cancelled) setEngines(Array.isArray(detected) ? detected : []);
      })
      .catch((detectError) => {
        if (!cancelled) setActionError(errorMessage(detectError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const taskIds = detail.tasks.map((task) => task.id);
    setTaskStaffing({});
    if (taskIds.length === 0) return;

    void Promise.all(
      taskIds.map(
        async (taskId) =>
          [taskId, await getWorkspaceTaskStaffing(taskId)] as const,
      ),
    )
      .then((entries) => {
        if (cancelled) return;
        setTaskStaffing(Object.fromEntries(entries));
      })
      .catch((staffingError: unknown) => {
        if (!cancelled) setActionError(errorMessage(staffingError));
      });

    return () => {
      cancelled = true;
    };
  }, [detail.tasks]);

  useEffect(() => {
    if (capabilityPickedManually) return;
    if (!taskTitle.trim() && !taskDetails.trim()) {
      setTaskCapability(null);
      setSuggestedCapability(null);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void suggestTaskCapability(taskTitle, taskDetails)
        .then((suggestion) => {
          if (cancelled) return;
          const matched = CAPABILITY_OPTIONS.find(
            (option) => option.value === suggestion,
          );
          const next = matched?.value ?? null;
          setTaskCapability(next);
          setSuggestedCapability(next);
        })
        .catch(() => {
          if (cancelled) return;
          setTaskCapability(null);
          setSuggestedCapability(null);
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [capabilityPickedManually, taskDetails, taskTitle]);

  useEffect(() => {
    const requestVersion = groundingPreviewVersion.current + 1;
    groundingPreviewVersion.current = requestVersion;
    const title = taskTitle.trim();
    if (!title) {
      setGroundingPreview(null);
      setGroundingPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setGroundingPreview(null);
    setGroundingPreviewLoading(true);
    const timeout = window.setTimeout(() => {
      void previewTaskGrounding(detail.workspace.id, title, taskDetails.trim())
        .then((preview) => {
          if (
            cancelled ||
            groundingPreviewVersion.current !== requestVersion
          ) {
            return;
          }
          setGroundingPreview(preview);
          setGroundingPreviewLoading(false);
        })
        .catch((previewError: unknown) => {
          if (
            cancelled ||
            groundingPreviewVersion.current !== requestVersion
          ) {
            return;
          }
          console.warn("Failed to preview task grounding", previewError);
          setGroundingPreview(null);
          setGroundingPreviewLoading(false);
        });
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [detail.workspace.id, taskDetails, taskTitle]);

  useEffect(() => {
    let cancelled = false;
    void getSetupStatus()
      .then((setup) => {
        if (!cancelled) {
          setInstalledModels(setup?.profiles.filter((profile) => profile.installed) ?? []);
        }
      })
      .catch((setupError: unknown) => {
        if (!cancelled) setActionError(errorMessage(setupError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listWorkspaceAddons()
      .then((addons) => {
        if (!cancelled) setCatalog(Array.isArray(addons) ? addons : []);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setActionError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getContextSources()
      .then((sources) => {
        if (!cancelled && sources) setContextSources(sources);
      })
      .catch(() => {
        // The rows already render the setup path; a settings hint is more
        // useful here than turning a background config read into a pane error.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLatestRuns({});
    setExpandedArtifacts(new Set());
    const taskIds = detail.tasks
      .filter((task) =>
        ["awaiting_review", "done", "failed"].includes(task.status),
      )
      .map((task) => task.id);
    if (taskIds.length === 0) return;

    void Promise.all(
      taskIds.map(async (taskId) => [taskId, await getLatestWorkspaceRun(taskId)] as const),
    )
      .then((entries) => {
        if (cancelled) return;
        const runs: Record<number, WorkspaceRun> = {};
        for (const [taskId, run] of entries) {
          if (run) runs[taskId] = run;
        }
        setLatestRuns(runs);
      })
      .catch((runError: unknown) => {
        if (!cancelled) setActionError(errorMessage(runError));
      });

    return () => {
      cancelled = true;
    };
  }, [detail]);

  useEffect(() => {
    const taskIds = pollingTaskKey
      ? pollingTaskKey.split(",").map((id) => Number(id))
      : [];
    if (taskIds.length === 0) return;

    let cancelled = false;
    const intervals = new Map<number, number>();
    const poll = (taskId: number) => {
      void getLatestWorkspaceRun(taskId)
        .then((run) => {
          if (cancelled || !run) return;
          setPolledRuns((current) => ({ ...current, [taskId]: run }));
          if (run.status !== "running") {
            const interval = intervals.get(taskId);
            if (interval !== undefined) window.clearInterval(interval);
            intervals.delete(taskId);
            void onRefresh();
          }
        })
        .catch((runError: unknown) => {
          if (!cancelled) setActionError(errorMessage(runError));
        });
    };

    for (const taskId of taskIds) {
      const interval = window.setInterval(() => poll(taskId), 2000);
      intervals.set(taskId, interval);
      poll(taskId);
    }

    return () => {
      cancelled = true;
      intervals.forEach((interval) => window.clearInterval(interval));
    };
  }, [onRefresh, pollingTaskKey]);

  const selectedEngineId = engines.some(
    (engine) => engine.id === detail.workspace.engine,
  )
    ? detail.workspace.engine
    : "local";
  const selectedEngine = engines.find((engine) => engine.id === selectedEngineId);
  const selectedEngineAvailable = selectedEngine?.available === true;
  const selectedCapabilityOption = CAPABILITY_OPTIONS.find(
    (option) => option.value === taskCapability,
  );
  const selectedAdapter = selectedCapabilityOption
    ? installedAdapter(selectedCapabilityOption, catalog)
    : undefined;
  const capabilityHint = selectedCapabilityOption
    ? selectedAdapter
      ? `Runs as ${selectedAdapter.name}.`
      : BASELINE_HINTS[selectedCapabilityOption.value]
    : null;

  const submitTask = async () => {
    const title = taskTitle.trim();
    if (!title || !taskCapability || creatingTask) return;
    setCreatingTask(true);
    setActionError(null);
    groundingPreviewVersion.current += 1;
    setGroundingPreview(null);
    setGroundingPreviewLoading(false);
    try {
      await createWorkspaceTask(
        detail.workspace.id,
        title,
        taskDetails.trim(),
        null,
        null,
        taskCapability,
      );
      setTaskTitle("");
      setTaskDetails("");
      setTaskCapability(null);
      setSuggestedCapability(null);
      setCapabilityPickedManually(false);
      await onRefresh();
    } catch (taskError) {
      setActionError(errorMessage(taskError));
    } finally {
      setCreatingTask(false);
    }
  };

  const chooseEngine = async (engine: WorkspaceEngine) => {
    if (!engine.available || engine.id === selectedEngineId || engineBusy) return;
    setEngineBusy(true);
    setActionError(null);
    try {
      await setWorkspaceEngine(detail.workspace.id, engine.id);
      await onRefresh();
    } catch (selectionError) {
      setActionError(errorMessage(selectionError));
    } finally {
      setEngineBusy(false);
    }
  };

  const chooseModel = async (model: string) => {
    if (model === detail.workspace.model || modelBusy) return;
    setModelBusy(true);
    setActionError(null);
    try {
      await setWorkspaceModel(detail.workspace.id, model);
      await onRefresh();
    } catch (selectionError) {
      setActionError(errorMessage(selectionError));
    } finally {
      setModelBusy(false);
    }
  };

  const saveInstructions = async () => {
    setSavingInstructions(true);
    setInstructionsError(null);
    try {
      await setWorkspaceInstructions(detail.workspace.id, instructionsDraft);
      setSavedInstructions(instructionsDraft);
      setInstructionsSaved(true);
      void onRefresh();
    } catch (saveError) {
      setInstructionsError(String(saveError));
    } finally {
      setSavingInstructions(false);
    }
  };

  const toggleNetwork = async () => {
    if (updatingNetwork) return;
    setUpdatingNetwork(true);
    setNetworkError(null);
    try {
      await setWorkspaceNetworkAllowed(
        detail.workspace.id,
        !detail.workspace.network_allowed,
      );
      await onRefresh();
    } catch (networkUpdateError) {
      setNetworkError(errorMessage(networkUpdateError));
    } finally {
      setUpdatingNetwork(false);
    }
  };

  const toggleSkill = async (addon: WorkspaceAddon) => {
    if (pendingAddonId !== null) return;
    setPendingAddonId(addon.id);
    setActionError(null);
    try {
      if (attachedSkillIds.has(addon.id)) {
        await detachWorkspaceAddon(detail.workspace.id, addon.id);
      } else {
        await attachWorkspaceAddon(detail.workspace.id, addon.id);
      }
      await onRefresh();
    } catch (changeError) {
      setActionError(errorMessage(changeError));
    } finally {
      setPendingAddonId(null);
    }
  };

  const startRun = async (taskId: number) => {
    setActionError(null);
    setActiveRun({
      taskId,
      engine: selectedEngineId,
      pending: true,
      run: null,
      log: "",
      error: "",
    });
    let runSettled = false;
    let locatingRun = false;
    const locateRun = async () => {
      if (locatingRun || runSettled) return;
      locatingRun = true;
      try {
        for (let attempt = 0; attempt < 50 && !runSettled; attempt += 1) {
          try {
            const latest = await getLatestWorkspaceRun(taskId);
            if (
              latest?.status === "running" &&
              latest.engine === selectedEngineId
            ) {
              setActiveRun((current) =>
                current?.taskId === taskId ? { ...current, run: latest } : current,
              );
              return;
            }
          } catch {
            // The run command and lookup are separate IPC calls; retry a transient race.
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
        }
      } finally {
        locatingRun = false;
      }
    };

    const runPromise = runWorkspaceTask(taskId, selectedEngineId, (line) => {
      setActiveRun((current) =>
        current?.taskId === taskId
          ? { ...current, log: current.log + line }
          : current,
      );
      void locateRun();
    });
    void locateRun();
    try {
      const finished = await runPromise;
      runSettled = true;
      setActiveRun((current) =>
        current?.taskId === taskId
          ? { ...current, pending: false, run: finished, error: "" }
          : current,
      );
      await onRefresh();
    } catch (runError) {
      runSettled = true;
      const message = errorMessage(runError);
      setActiveRun((current) =>
        current?.taskId === taskId
          ? { ...current, pending: false, error: message }
          : current,
      );
      setActionError(message);
    }
  };

  const stopRun = async () => {
    if (!activeRun?.run) return;
    setActionError(null);
    try {
      await stopWorkspaceRun(activeRun.run.id);
      const stopped = await getLatestWorkspaceRun(activeRun.taskId);
      setActiveRun((current) =>
        current
          ? { ...current, pending: false, run: stopped ?? current.run, error: "" }
          : current,
      );
      await onRefresh();
    } catch (stopError) {
      setActionError(errorMessage(stopError));
    }
  };

  const stopPolledRun = async (run: WorkspaceRun) => {
    setActionError(null);
    try {
      await stopWorkspaceRun(run.id);
      await onRefresh();
    } catch (stopError) {
      setActionError(errorMessage(stopError));
    }
  };

  const approveTask = async (taskId: number) => {
    setActionError(null);
    setVerdictTaskId(taskId);
    try {
      await approveWorkspaceTask(taskId);
      await onRefresh();
    } catch (approveError) {
      setActionError(errorMessage(approveError));
    } finally {
      setVerdictTaskId(null);
    }
  };

  const rejectTask = async (taskId: number) => {
    const reason = rejectionReason.trim();
    if (!reason) return;
    setActionError(null);
    setVerdictTaskId(taskId);
    try {
      await rejectWorkspaceTask(taskId, reason);
      setRejectingTaskId(null);
      setRejectionReason("");
      void startRun(taskId);
    } catch (rejectError) {
      setActionError(errorMessage(rejectError));
    } finally {
      setVerdictTaskId(null);
    }
  };

  const setAgentEligibility = async (taskId: number, eligible: boolean) => {
    setActionError(null);
    setEligibilityTaskId(taskId);
    try {
      await setWorkspaceTaskAgentEligible(taskId, eligible);
      await onRefresh();
    } catch (eligibilityError) {
      setActionError(errorMessage(eligibilityError));
    } finally {
      setEligibilityTaskId(null);
    }
  };

  const openArtifact = async (path: string) => {
    setActionError(null);
    try {
      await openWorkspaceArtifact(path);
    } catch (openError) {
      setActionError(errorMessage(openError));
    }
  };

  const revealArtifact = async (path: string) => {
    setActionError(null);
    try {
      await revealWorkspaceArtifact(path);
    } catch (revealError) {
      setActionError(errorMessage(revealError));
    }
  };

  const toggleArtifactPreview = (artifactId: number) => {
    setExpandedArtifacts((current) => {
      const next = new Set(current);
      if (next.has(artifactId)) next.delete(artifactId);
      else next.add(artifactId);
      return next;
    });
  };

  const toggleTaskDetails = (taskId: number) => {
    setExpandedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const renderArtifactList = (artifacts: WorkspaceArtifact[]) => (
    <div className="ws-artifact-list">
      {artifacts.map((artifact) => (
        <div key={artifact.id}>
          <div className="ws-artifact-row">
            <FileText size={15} aria-hidden="true" />
            <span className="ws-artifact-name">{artifact.name}</span>
            <time dateTime={artifact.created_at}>
              {new Date(artifact.created_at).toLocaleDateString()}
            </time>
            <div className="ws-task-actions">
              <button
                className="ws-artifact-open"
                type="button"
                onClick={() => void openArtifact(artifact.path)}
              >
                Open
              </button>
              <button
                className="ws-artifact-open"
                type="button"
                onClick={() => void revealArtifact(artifact.path)}
              >
                Reveal
              </button>
              <button
                className="ws-artifact-open"
                type="button"
                onClick={() => toggleArtifactPreview(artifact.id)}
              >
                {expandedArtifacts.has(artifact.id) ? "Hide" : "Preview"}
              </button>
            </div>
          </div>
          {expandedArtifacts.has(artifact.id) && (
            <ArtifactPreview artifact={artifact} />
          )}
        </div>
      ))}
    </div>
  );

  const renderTaskRow = (task: WorkspaceTask) => {
    const isActive = activeRun?.taskId === task.id;
    const isRunning = task.status === "running" || (isActive && activeRun.pending);
    const run = isActive
      ? activeRun.run ?? polledRuns[task.id] ?? latestRuns[task.id]
      : polledRuns[task.id] ?? latestRuns[task.id];
    const artifacts = run
      ? detail.artifacts.filter((artifact) => artifact.run_id === run.id)
      : [];
    const expanded = expandedTaskIds.has(task.id);
    const showingRejectForm = rejectingTaskId === task.id;
    const verdictPending = verdictTaskId === task.id;
    const runLog = isActive
      ? activeRun.log || run?.log || ""
      : run?.log || "";
    const receipt = runLog
      .split(/\r?\n/)
      .find((line) => line.startsWith("Context:"));
    const runError = isActive ? activeRun.error || run?.error : run?.error;
    const finishedAt = run?.finished_at || task.updated_at;
    const finishedDate = new Date(finishedAt);
    const finishedDateLabel = Number.isFinite(finishedDate.getTime())
      ? finishedDate.toLocaleDateString()
      : "Finished";

    return (
      <div className="ws-task-block" key={task.id}>
        <div
          className={`ws-task-row${expanded ? " ws-task-row--expanded" : ""}`}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-controls={`workspace-task-details-${task.id}`}
          aria-label={`${task.title} details`}
          title={task.status === "failed" ? runError || undefined : undefined}
          onClick={() => toggleTaskDetails(task.id)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleTaskDetails(task.id);
            }
          }}
        >
          <CapabilityBadge capability={task.capability} />
          <span className="ws-task-title">{task.title}</span>
          <div className="ws-task-status">
            {isRunning ? (
              <span
                className="ws-running-affordance"
                role="status"
                aria-label={`Running, ${elapsedRunTime(run, runClock)}`}
              >
                <span className="ws-progress-spinner" aria-hidden="true" />
                <span>{elapsedRunTime(run, runClock)}</span>
              </span>
            ) : task.status === "awaiting_review" ? (
              <>
                {artifacts.length > 0 && (
                  <button
                    className="ws-task-action-button"
                    type="button"
                    aria-label="Reveal in Finder"
                    title="Reveal in Finder"
                    disabled={verdictPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      void revealArtifact(artifacts[0].path);
                    }}
                  >
                    <FolderOpen size={14} aria-hidden="true" />
                  </button>
                )}
                <button
                  className="ws-task-action-button ws-task-action-button--approve"
                  type="button"
                  aria-label="Approve"
                  title="Approve"
                  disabled={verdictPending}
                  onClick={(event) => {
                    event.stopPropagation();
                    void approveTask(task.id);
                  }}
                >
                  <Check size={15} aria-hidden="true" />
                </button>
                <button
                  className="ws-task-action-button ws-task-action-button--reject"
                  type="button"
                  aria-label="Reject"
                  title="Reject"
                  disabled={verdictPending}
                  onClick={(event) => {
                    event.stopPropagation();
                    setRejectingTaskId(showingRejectForm ? null : task.id);
                    setRejectionReason("");
                  }}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </>
            ) : task.status === "done" ? (
              <span className="ws-done-affordance">
                <Check size={15} aria-hidden="true" />
                <time dateTime={finishedAt}>{finishedDateLabel}</time>
              </span>
            ) : (
              <>
                {task.status === "failed" && (
                  <span className="ws-failed-tag">failed</span>
                )}
                <button
                  className="ws-task-action-button ws-task-run-button"
                  type="button"
                  aria-label="Run"
                  title="Run"
                  disabled={!selectedEngineAvailable}
                  onClick={(event) => {
                    event.stopPropagation();
                    void startRun(task.id);
                  }}
                >
                  <Play size={13} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </div>

        {showingRejectForm && (
          <form
            className="ws-inline-reject-row"
            onSubmit={(event) => {
              event.preventDefault();
              void rejectTask(task.id);
            }}
          >
            <input
              className="ws-inline-input"
              aria-label="Rejection reason"
              placeholder="What should be different?"
              value={rejectionReason}
              autoFocus
              onChange={(event) => setRejectionReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setRejectingTaskId(null);
                  setRejectionReason("");
                }
              }}
            />
            <button
              className="btn-primary"
              type="submit"
              disabled={!rejectionReason.trim() || verdictPending}
            >
              Rerun
            </button>
            <button
              className="btn-secondary"
              type="button"
              onClick={() => {
                setRejectingTaskId(null);
                setRejectionReason("");
              }}
            >
              Cancel
            </button>
          </form>
        )}

        {expanded && (
          <div
            className="ws-task-details"
            id={`workspace-task-details-${task.id}`}
          >
            {run?.report.trim() && (
              <p className="ws-task-report">{run.report}</p>
            )}
            {artifacts.length > 0 && renderArtifactList(artifacts)}
            {receipt && <p className="ws-receipt">{receipt}</p>}
            {task.rejection_notes.length > 0 && (
              <ul className="ws-rejections">
                {task.rejection_notes.map((note, index) => (
                  <li key={`${task.id}-${index}`}>{note}</li>
                ))}
              </ul>
            )}
            {(task.status === "queued" ||
              task.status === "failed" ||
              isRunning) && (
              <TaskStaffingLine
                task={task}
                staffing={taskStaffing[task.id]}
                catalog={catalog}
                engine={selectedEngineId}
              />
            )}
            {task.source_meeting_id != null && (
              <button
                className="triage-card-src ws-source-chip"
                type="button"
                onClick={() => onOpenMeeting(task.source_meeting_id!)}
              >
                from: {task.source_meeting_title}
              </button>
            )}
            {(task.attempt > 1 ||
              task.status === "queued" ||
              task.status === "failed" ||
              task.status === "done" ||
              isRunning) && (
              <div className="ws-task-detail-actions">
                {task.attempt > 1 && (
                  <span className="ws-attempt">attempt {task.attempt}</span>
                )}
                {(task.status === "queued" || task.status === "failed") && (
                  <button
                    className="btn-secondary ws-eligibility-button"
                    type="button"
                    disabled={
                      (isActive && activeRun.pending) ||
                      eligibilityTaskId === task.id
                    }
                    onClick={() =>
                      void setAgentEligibility(task.id, !task.agent_eligible)
                    }
                  >
                    {task.agent_eligible
                      ? "Mark as needs me"
                      : "Let an agent try"}
                  </button>
                )}
                {isRunning && run?.engine !== "local" && (
                  <button
                    className="btn-secondary ws-run-stop"
                    type="button"
                    disabled={!run}
                    onClick={() => {
                      if (isActive) void stopRun();
                      else if (run) void stopPolledRun(run);
                    }}
                  >
                    Stop
                  </button>
                )}
                {!isRunning && task.status !== "awaiting_review" && (
                  <button
                    className="ws-icon-button"
                    type="button"
                    aria-label={`Delete task ${task.title}`}
                    onClick={() => void onDeleteTask(task.id)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
            {(runLog || runError) && (
              <details className="ws-runlog">
                <summary>Run log</summary>
                {runLog && <pre aria-live={isRunning ? "polite" : undefined}>{runLog}</pre>}
                {runError && <p className="ws-error">{runError}</p>}
              </details>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="ws-detail">
      <header className="ws-detail-heading">
        <button
          className="btn-secondary ws-back"
          type="button"
          onClick={onBack}
        >
          ← Workspaces
        </button>
        <div className="ws-detail-heading-main">
          <div className="ws-detail-name-row">
            <h2>{detail.workspace.name}</h2>
            {awaitingTasks.length > 0 && (
              <span className="badge-tag ws-review-badge">
                {awaitingTasks.length} awaiting review
              </span>
            )}
          </div>
          <p className="ws-knows-line">
            {countLabel(meetingCount, "meeting")} ·{" "}
            {countLabel(folderCount, "folder")} ·{" "}
            {countLabel(attachedSkills.length, "skill")} attached ·{" "}
            {countLabel(doneTasks.length, "task")} done
          </p>
        </div>
        <button
          className="btn-secondary ws-settings-button"
          type="button"
          aria-expanded={settingsOpen}
          aria-controls="workspace-project-settings"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Settings size={14} aria-hidden="true" />
          Project settings
        </button>
      </header>

      {(actionError || error) && (
        <p className="ws-error">{actionError || error}</p>
      )}

      <div className="ws-detail-grid">
        <div className="ws-detail-column ws-detail-primary">
          <section
            className="ws-pane"
            aria-labelledby="workspace-create-task-title"
          >
            <h3 id="workspace-create-task-title">New task</h3>
            <form
              className="ws-addon-form ws-task-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitTask();
              }}
            >
            <input
              className="ws-inline-input ws-add-input"
              value={taskTitle}
              placeholder="Task title…"
              aria-label="Task title"
              onChange={(event) => setTaskTitle(event.target.value)}
            />
            <textarea
              className="ws-inline-input ws-add-input"
              style={{ minHeight: "68px", resize: "vertical" }}
              value={taskDetails}
              placeholder="Details (optional)…"
              aria-label="Task details"
              onChange={(event) => setTaskDetails(event.target.value)}
            />
            <div
              role="group"
              aria-label="How should AI help"
              style={{
                alignItems: "center",
                display: "flex",
                flexWrap: "wrap",
                gap: "6px",
              }}
            >
              {CAPABILITY_OPTIONS.map((option) => {
                const selected = taskCapability === option.value;
                const suggested = suggestedCapability === option.value;
                return (
                  <span
                    key={option.value}
                    style={{
                      alignItems: "center",
                      display: "inline-flex",
                      gap: "5px",
                    }}
                  >
                    <button
                      className={`tag-pill${selected ? " active" : ""}`}
                      type="button"
                      aria-pressed={selected}
                      style={{
                        borderRadius: "12px",
                        fontSize: "11px",
                        fontWeight: 500,
                        padding: "4px 10px",
                      }}
                      onClick={() => {
                        setTaskCapability(option.value);
                        setSuggestedCapability(null);
                        setCapabilityPickedManually(true);
                      }}
                    >
                      + {option.label}
                    </button>
                    {suggested && (
                      <span style={{ color: "#8ec5ff", fontSize: "10px" }}>
                        suggested
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
            {capabilityHint && (
              <p
                style={{
                  color: "var(--text-muted)",
                  fontSize: "11px",
                  margin: 0,
                }}
              >
                {capabilityHint}
              </p>
            )}
            <button
              className="btn-primary"
              type="submit"
              disabled={!taskTitle.trim() || !taskCapability || creatingTask}
            >
              Create
            </button>
            </form>
          </section>

          <section className="ws-pane" aria-labelledby="workspace-tasks-title">
            <h3 id="workspace-tasks-title">Tasks</h3>
            <div className="ws-list">
              {awaitingTasks.length > 0 && (
                <>
                  <h4 className="ws-section-title">
                    Needs you · {awaitingTasks.length}
                  </h4>
                  {awaitingTasks.map(renderTaskRow)}
                </>
              )}

              {runningTasks.length > 0 && (
                <>
                  <h4 className="ws-section-title">
                    Running · {runningTasks.length}
                  </h4>
                  {runningTasks.map(renderTaskRow)}
                </>
              )}

              <h4 className="ws-section-title">
                Queued · {queuedTasks.length}
              </h4>
              {detail.tasks.length === 0 ? (
                <p className="ws-pane-empty">
                  No tasks yet. Send one from the to-do board, or add one below.
                </p>
              ) : (
                queuedTasks.map(renderTaskRow)
              )}

              {doneTasks.length > 0 && (
                <>
                  <h4 className="ws-section-title">
                    Done · {doneTasks.length}
                  </h4>
                  {doneTasks.map(renderTaskRow)}
                </>
              )}
            </div>
          {remainingArtifacts.length > 0 && (
            <div className="ws-artifacts">
              <h4>Artifacts</h4>
              <div className="ws-artifact-list">
                {remainingArtifacts.map((artifact) => (
                  <div key={artifact.id}>
                    <div className="ws-artifact-row">
                      <FileText size={15} aria-hidden="true" />
                      <span className="ws-artifact-name">{artifact.name}</span>
                      <time dateTime={artifact.created_at}>
                        {new Date(artifact.created_at).toLocaleDateString()}
                      </time>
                      <div className="ws-task-actions">
                        <button
                          className="ws-artifact-open"
                          type="button"
                          onClick={() => void openArtifact(artifact.path)}
                        >
                          Open
                        </button>
                        <button
                          className="ws-artifact-open"
                          type="button"
                          onClick={() => toggleArtifactPreview(artifact.id)}
                        >
                          {expandedArtifacts.has(artifact.id) ? "Hide" : "Preview"}
                        </button>
                      </div>
                    </div>
                    {expandedArtifacts.has(artifact.id) && (
                      <ArtifactPreview artifact={artifact} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          </section>
        </div>

        <aside
          className="ws-detail-column ws-detail-secondary"
          aria-label="Project brain"
        >
          <section className="ws-pane" aria-labelledby="workspace-grounded-title">
            <h3 id="workspace-grounded-title">Grounded in</h3>
            <div className="ws-grounding-list">
              {folderContextItems.map((item) => (
                <div className="ws-grounding-row" key={item.id}>
                  <Folder size={14} aria-hidden="true" />
                  <span className="ws-grounding-path" title={item.value}>
                    {item.value}
                  </span>
                  <span className="ws-read-only-tag">read-only</span>
                </div>
              ))}
              <div className="ws-grounding-row">
                <CalendarDays size={14} aria-hidden="true" />
                <span>{meetingCount} bound meetings</span>
              </div>
              <div
                className={`ws-grounding-row${
                  contextSources.vault_path ? "" : " ws-grounding-row--muted"
                }`}
              >
                <BookOpen size={14} aria-hidden="true" />
                <span>
                  {contextSources.vault_path
                    ? "vault indexed"
                    : "vault not set · Settings → Integrations"}
                </span>
              </div>
            </div>
          </section>

          <section
            className="ws-pane ws-instructions-card"
            aria-labelledby="workspace-instructions-title"
          >
            <h3 id="workspace-instructions-title">Standing instructions</h3>
            <p className="ws-instructions-hint">
              Guides the Project overview and every task brief.
            </p>
            <textarea
              className="ws-inline-input ws-instructions-textarea"
              aria-label="Standing instructions"
              value={instructionsDraft}
              placeholder="For example: prioritize technical risks, keep decisions concise, and flag anything without an owner."
              onChange={(event) => {
                setInstructionsDraft(event.target.value);
                setInstructionsSaved(false);
                setInstructionsError(null);
              }}
            />
            <div className="ws-instructions-footer">
              <span className="ws-instructions-device-note">
                Saved on this device and applied across this project.
              </span>
              <div className="ws-instructions-status">
                {instructionsError && (
                  <span role="alert" className="ws-instructions-error">
                    {instructionsError}
                  </span>
                )}
                {instructionsChanged ? (
                  <button
                    type="button"
                    className="btn-popup-action confirm"
                    disabled={savingInstructions}
                    onClick={() => void saveInstructions()}
                    style={{ height: 24, fontSize: 11, padding: "0 10px" }}
                  >
                    Save
                  </button>
                ) : instructionsSaved ? (
                  <span className="ws-instructions-saved">Saved</span>
                ) : null}
              </div>
            </div>
          </section>

          {taskTitle.trim() &&
            (groundingPreviewLoading || groundingPreview) && (
              <section
                className="ws-pane ws-draft-grounding-card"
                aria-labelledby="workspace-draft-grounding-title"
              >
                <h3 id="workspace-draft-grounding-title">
                  For the drafted task
                </h3>
                {groundingPreviewLoading ? (
                  <p className="ws-draft-grounding-loading">
                    Looking at what would ground this…
                  </p>
                ) : groundingPreview ? (
                  <div className="ws-grounding-preview-lines">
                    <p>
                      {groundingPreview.related_meeting_count} related meetings
                      {groundingPreview.latest_related_title
                        ? ` · latest: ${groundingPreview.latest_related_title}`
                        : ""}
                    </p>
                    <p>
                      {groundingPreview.vault_hit_count} vault hits
                      {groundingPreview.top_vault_label
                        ? ` · top: ${groundingPreview.top_vault_label}`
                        : ""}
                    </p>
                    <p>
                      {groundingPreview.project_hit_count} project folder matches
                    </p>
                  </div>
                ) : null}
                <p className="ws-draft-grounding-footer">
                  Every run keeps a receipt naming exactly what it used.
                </p>
              </section>
            )}

          <section
            className="ws-pane ws-web-research-card"
            aria-labelledby="workspace-web-research-title"
          >
            <div className="ws-web-research-main">
              <Globe size={16} aria-hidden="true" />
              <div className="ws-web-research-copy">
                <h3 id="workspace-web-research-title">Web research</h3>
                <p>
                  On: research tasks may fetch from the web and every fetched URL
                  is listed in the report.
                </p>
                {networkError && (
                  <p role="alert" className="ws-instructions-error">
                    {networkError}
                  </p>
                )}
              </div>
              <div className="ws-switch-wrap">
                <span>{detail.workspace.network_allowed ? "On" : "Off"}</span>
                <button
                  className="ws-toggle-switch"
                  type="button"
                  role="switch"
                  aria-checked={detail.workspace.network_allowed}
                  aria-label="Web research"
                  disabled={updatingNetwork}
                  onClick={() => void toggleNetwork()}
                >
                  <span aria-hidden="true" />
                </button>
              </div>
            </div>
          </section>

        {settingsOpen && (
          <section
            id="workspace-project-settings"
            className="ws-pane ws-project-settings"
            aria-labelledby="workspace-project-settings-title"
          >
            <h3 id="workspace-project-settings-title">Project settings</h3>
            <h4 className="ws-section-title">Engine</h4>
            <div className="ws-engine-picker">
              <div
                className="ws-engine-row"
                role="group"
                aria-label="Workspace engine"
              >
                {engines.map((engine) =>
                  engine.available ? (
                    <button
                      className={`badge-tag blue ws-engine-chip${
                        engine.id === selectedEngineId
                          ? " ws-engine-chip--selected"
                          : ""
                      }`}
                      type="button"
                      aria-pressed={engine.id === selectedEngineId}
                      title={engine.version || undefined}
                      disabled={engineBusy}
                      key={engine.id}
                      onClick={() => void chooseEngine(engine)}
                    >
                      {engine.label}
                    </button>
                  ) : (
                    <span
                      className="badge-tag blue ws-engine-chip ws-engine-chip--dimmed"
                      title={engine.detail}
                      role="button"
                      aria-disabled="true"
                      aria-label={`${engine.label}. ${engine.detail}`}
                      tabIndex={0}
                      key={engine.id}
                    >
                      {engine.label}
                    </span>
                  ),
                )}
              </div>
              <p className="ws-context-caption">
                {engineCaption(selectedEngineId)}
              </p>
              {detail.workspace.engine === "local" && (
                <>
                  <select
                    className="ws-inline-input"
                    aria-label="Workspace model"
                    value={detail.workspace.model}
                    disabled={modelBusy}
                    onChange={(event) => void chooseModel(event.target.value)}
                  >
                    <option value="">Same as notes model</option>
                    {installedModels.map((profile) => (
                      <option value={profile.model_alias} key={profile.id}>
                        {profile.display_name}
                      </option>
                    ))}
                  </select>
                  <p className="ws-context-caption">
                    Workspace tasks can use a bigger model than your meeting notes.
                  </p>
                </>
              )}
            </div>

            <h4 className="ws-section-title">Sources</h4>
            <div className="ws-list">
              <div className="ws-list-item ws-list-item--auto">
                <span className="ws-context-icon" aria-hidden="true">
                  ◉
                </span>
                <span className="ws-item-label">
                  Related meetings via graph
                  <span className="m-dim"> · top 3, automatic</span>
                </span>
              </div>
              <div className="ws-list-item ws-list-item--auto">
                <span className="ws-context-icon" aria-hidden="true">
                  ◆
                </span>
                <span className="ws-item-label ws-auto-context-label">
                  <span>
                    Vault notes via search
                    <span className="m-dim"> · top 5, automatic</span>
                  </span>
                  <span className="m-dim ws-auto-context-path">
                    {contextSources.vault_path ||
                      "Set up in Settings → Integrations"}
                  </span>
                </span>
              </div>
              <div className="ws-list-item ws-list-item--auto">
                <span className="ws-context-icon" aria-hidden="true">
                  ◫
                </span>
                <span className="ws-item-label ws-auto-context-label">
                  <span>
                    Projects via search
                    <span className="m-dim"> · top 2, automatic</span>
                  </span>
                  <span className="m-dim ws-auto-context-path">
                    {contextSources.projects_root ||
                      "Set up in Settings → Integrations"}
                  </span>
                </span>
              </div>
              {detail.context_items.map((item) => (
                <div className="ws-list-item" key={item.id}>
                  <span className="ws-context-icon">{contextIcon(item)}</span>
                  {item.kind === "meeting" ? (
                    <button
                      className="ws-context-link"
                      type="button"
                      onClick={() => onOpenMeeting(Number(item.value))}
                    >
                      {item.label}
                    </button>
                  ) : (
                    <span className="ws-item-label">{item.label}</span>
                  )}
                  <button
                    className="ws-icon-button"
                    type="button"
                    aria-label={`Remove ${item.label} from context`}
                    onClick={() => void onRemoveContext(item.id)}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            <button
              className="btn-secondary ws-add-folder"
              type="button"
              onClick={() => void onAddFolder()}
            >
              <Folder size={15} aria-hidden="true" />
              Add folder…
            </button>

            <h4 className="ws-section-title">Skills</h4>
            <div className="ws-addon-row">
              {catalogSkills.map((addon) => (
                <button
                  className="badge-tag ws-addon-chip"
                  type="button"
                  key={addon.id}
                  aria-pressed={attachedSkillIds.has(addon.id)}
                  disabled={pendingAddonId !== null}
                  title={addon.description}
                  onClick={() => void toggleSkill(addon)}
                >
                  {addon.name}
                </button>
              ))}
            </div>
            <p className="ws-context-caption">
              What you add here is what the agent will be allowed to read. Related
              meetings are pulled from your graph automatically. The selected
              capability sets the baseline deliverable, and attached skills can
              upgrade it.
            </p>
          </section>
        )}
        </aside>
      </div>
    </div>
  );
}
