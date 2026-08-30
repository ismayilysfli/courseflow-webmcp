import {
  AssignmentAnalysis,
  AvailabilityWindow,
  FeasibilityStatus,
  FeasibilitySummary,
  PlanResult,
  ScheduledBlock,
  TaskEstimate,
  TaskScheduleSummary,
} from '../types.js';

export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerError';
  }
}

export interface TaskNode {
  task: TaskEstimate;
  dependencyIds: string[];
  originalIndex: number;
}

export interface CapacitySlot {
  start: Date;
  end: Date;
  cursor: Date;
}

export function normalizeAnalysis(analysis: AssignmentAnalysis): AssignmentAnalysis {
  const tasks: TaskEstimate[] = (analysis.tasks || []).map((task, index) => ({
    ...task,
    task_id: `task-${index + 1}`,
    is_optional: Boolean(task.is_optional),
  }));

  const titles = new Map<string, string>();
  for (const task of tasks) {
    if (titles.has(task.title)) {
      throw new PlannerError(`Duplicate task title: ${JSON.stringify(task.title)}.`);
    }
    titles.set(task.title, task.task_id!);
  }

  const taskIds = new Set(tasks.map((t) => t.task_id!));
  const dependencies = new Map<string, string[]>();

  for (const task of tasks) {
    const resolved: string[] = [];
    for (const dependency of task.dependencies || []) {
      const dependencyKey = dependency.trim();
      let dependencyId = titles.get(dependencyKey);
      if (!dependencyId && taskIds.has(dependencyKey)) {
        dependencyId = dependencyKey;
      }
      if (!dependencyId) {
        throw new PlannerError(
          `Task ${task.task_id} references unknown dependency ${JSON.stringify(dependency)}.`
        );
      }
      if (dependencyId === task.task_id) {
        throw new PlannerError(`Task ${task.task_id} cannot depend on itself.`);
      }
      if (!resolved.includes(dependencyId)) {
        resolved.push(dependencyId);
      }
    }
    dependencies.set(task.task_id!, resolved);
  }

  const state = new Map<string, number>(); // 0: unvisited, 1: visiting, 2: visited
  for (const task of tasks) {
    state.set(task.task_id!, 0);
  }

  function visit(taskId: string) {
    const currentState = state.get(taskId) ?? 0;
    if (currentState === 1) {
      throw new PlannerError('Task dependencies contain a cycle.');
    }
    if (currentState === 2) {
      return;
    }
    state.set(taskId, 1);
    const deps = dependencies.get(taskId) || [];
    for (const depId of deps) {
      visit(depId);
    }
    state.set(taskId, 2);
  }

  for (const task of tasks) {
    visit(task.task_id!);
  }

  return {
    ...analysis,
    tasks,
  };
}

export function orderedNodes(analysis: AssignmentAnalysis): TaskNode[] {
  const byTitle = new Map<string, string>();
  for (const task of analysis.tasks) {
    byTitle.set(task.title, task.task_id!);
  }

  const nodes: TaskNode[] = analysis.tasks.map((task, index) => ({
    task,
    dependencyIds: (task.dependencies || []).map(
      (dep) => byTitle.get(dep.trim()) || dep.trim()
    ),
    originalIndex: index,
  }));

  const nodesById = new Map<string, TaskNode>();
  for (const node of nodes) {
    nodesById.set(node.task.task_id!, node);
  }

  // Phase 1: Topological sort for mandatory tasks
  const mandatoryNodes = nodes.filter((n) => !n.task.is_optional);
  const mandatoryRemaining = new Map<string, Set<string>>();
  for (const node of mandatoryNodes) {
    mandatoryRemaining.set(
      node.task.task_id!,
      new Set(
        node.dependencyIds.filter(
          (depId) => !nodesById.get(depId)?.task.is_optional
        )
      )
    );
  }

  const mandatoryOrdered: TaskNode[] = [];
  while (mandatoryRemaining.size > 0) {
    const ready: TaskNode[] = [];
    for (const [taskId, deps] of mandatoryRemaining.entries()) {
      if (deps.size === 0) {
        ready.push(nodesById.get(taskId)!);
      }
    }

    if (ready.length === 0) {
      throw new PlannerError('Task dependencies contain a cycle.');
    }

    ready.sort((a, b) => a.originalIndex - b.originalIndex);

    for (const node of ready) {
      mandatoryOrdered.push(node);
      mandatoryRemaining.delete(node.task.task_id!);
    }

    const completedIds = new Set(ready.map((n) => n.task.task_id!));
    for (const deps of mandatoryRemaining.values()) {
      for (const compId of completedIds) {
        deps.delete(compId);
      }
    }
  }

  // Phase 2: Topological sort for optional tasks
  const optionalNodes = nodes.filter((n) => Boolean(n.task.is_optional));
  const optionalRemaining = new Map<string, Set<string>>();
  const satisfiedMandatoryIds = new Set(
    mandatoryOrdered.map((n) => n.task.task_id!)
  );

  for (const node of optionalNodes) {
    const deps = new Set(
      node.dependencyIds.filter((depId) => !satisfiedMandatoryIds.has(depId))
    );
    optionalRemaining.set(node.task.task_id!, deps);
  }

  const optionalOrdered: TaskNode[] = [];
  while (optionalRemaining.size > 0) {
    const ready: TaskNode[] = [];
    for (const [taskId, deps] of optionalRemaining.entries()) {
      if (deps.size === 0) {
        ready.push(nodesById.get(taskId)!);
      }
    }

    if (ready.length === 0) {
      throw new PlannerError('Task dependencies contain a cycle.');
    }

    ready.sort((a, b) => a.originalIndex - b.originalIndex);

    for (const node of ready) {
      optionalOrdered.push(node);
      optionalRemaining.delete(node.task.task_id!);
    }

    const completedIds = new Set(ready.map((n) => n.task.task_id!));
    for (const deps of optionalRemaining.values()) {
      for (const compId of completedIds) {
        deps.delete(compId);
      }
    }
  }

  return [...mandatoryOrdered, ...optionalOrdered];
}

export function parseDeadline(analysis: AssignmentAnalysis): Date | null {
  if (!analysis.deadline_iso) {
    return null;
  }
  const parsed = new Date(analysis.deadline_iso);
  if (isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

export function capacitySlots(
  availability: AvailabilityWindow[],
  deadline: Date | null
): CapacitySlot[] {
  const windows = [...availability]
    .map((w) => ({
      start: new Date(w.start),
      end: new Date(w.end),
    }))
    .filter((w) => !isNaN(w.start.getTime()) && !isNaN(w.end.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const slots: CapacitySlot[] = [];
  for (const window of windows) {
    let start = window.start;
    let end = window.end;

    if (deadline !== null) {
      if (start.getTime() >= deadline.getTime()) {
        continue;
      }
      if (end.getTime() > deadline.getTime()) {
        end = deadline;
      }
    }

    if (end.getTime() <= start.getTime()) {
      continue;
    }

    if (slots.length > 0 && start.getTime() <= slots[slots.length - 1].end.getTime()) {
      if (end.getTime() > slots[slots.length - 1].end.getTime()) {
        slots[slots.length - 1].end = end;
      }
    } else {
      slots.push({
        start,
        end,
        cursor: new Date(start.getTime()),
      });
    }
  }

  return slots;
}

export function slotMinutes(slots: CapacitySlot[]): number {
  return slots.reduce((total, slot) => {
    const mins = Math.floor((slot.end.getTime() - slot.start.getTime()) / 60000);
    return total + Math.max(0, mins);
  }, 0);
}

export function calculateStatus(
  optimistic: number,
  expected: number,
  pessimistic: number,
  available: number
): FeasibilityStatus {
  if (pessimistic <= available) {
    return 'comfortable';
  }
  if (expected <= available) {
    return 'tight';
  }
  if (optimistic <= available) {
    return 'at_risk';
  }
  return 'infeasible';
}

export function buildPlan(
  analysis: AssignmentAnalysis,
  availability: AvailabilityWindow[]
): PlanResult {
  const normalized = normalizeAnalysis(analysis);
  const nodes = orderedNodes(normalized);
  const deadline = parseDeadline(normalized);
  const slots = capacitySlots(availability, deadline);
  const availableMinutes = slotMinutes(slots);

  const mandatoryTasks = normalized.tasks.filter((t) => !t.is_optional);
  const optimisticWorkload = mandatoryTasks.reduce(
    (sum, t) => sum + (t.optimistic_minutes || 0),
    0
  );
  const expectedWorkload = mandatoryTasks.reduce(
    (sum, t) => sum + (t.expected_minutes || 0),
    0
  );
  const pessimisticWorkload = mandatoryTasks.reduce(
    (sum, t) => sum + (t.pessimistic_minutes || 0),
    0
  );

  const expectedShortfall = Math.max(0, expectedWorkload - availableMinutes);
  const optimisticShortfall = Math.max(0, optimisticWorkload - availableMinutes);

  const warnings: string[] = [];
  if (expectedShortfall > 0) {
    warnings.push(
      `Expected workload exceeds available capacity by ${expectedShortfall} minutes.`
    );
  }
  if (optimisticShortfall > 0) {
    warnings.push(
      `Optimistic workload exceeds available capacity by ${optimisticShortfall} minutes.`
    );
  }

  const scheduledBlocks: ScheduledBlock[] = [];
  const taskSummaries: TaskScheduleSummary[] = [];
  const completedTasks = new Set<string>();
  const completedEnd = new Map<string, Date>();
  const unfinishedTasks: string[] = [];
  let globalCursor: Date | null = null;

  for (const node of nodes) {
    const task = node.task;
    const missingDependencies = node.dependencyIds.filter(
      (depId) => !completedTasks.has(depId)
    );

    if (missingDependencies.length > 0) {
      unfinishedTasks.push(task.task_id!);
      warnings.push(
        `${task.task_id} was not scheduled because a prerequisite was unfinished.`
      );
      taskSummaries.push({
        task_id: task.task_id!,
        total_required_minutes: task.expected_minutes,
        total_scheduled_minutes: 0,
        completed_in_plan: false,
      });
      continue;
    }

    if (task.is_optional) {
      const mandatoryIncomplete = mandatoryTasks.some(
        (t) => !completedTasks.has(t.task_id!)
      );
      if (expectedWorkload > availableMinutes || mandatoryIncomplete) {
        unfinishedTasks.push(task.task_id!);
        warnings.push(
          `${task.task_id} could only be scheduled for 0 of ${task.expected_minutes} minutes.`
        );
        taskSummaries.push({
          task_id: task.task_id!,
          total_required_minutes: task.expected_minutes,
          total_scheduled_minutes: 0,
          completed_in_plan: false,
        });
        continue;
      }
    }

    let dependencyEnd: Date | null = null;
    for (const depId of node.dependencyIds) {
      const depDate = completedEnd.get(depId);
      if (depDate) {
        if (!dependencyEnd || depDate.getTime() > dependencyEnd.getTime()) {
          dependencyEnd = depDate;
        }
      }
    }

    let earliestStart: Date | null = dependencyEnd;
    if (globalCursor !== null) {
      earliestStart =
        earliestStart !== null
          ? new Date(Math.max(earliestStart.getTime(), globalCursor.getTime()))
          : globalCursor;
    }

    let remaining = task.expected_minutes;
    const taskBlocks: ScheduledBlock[] = [];

    for (const slot of slots) {
      let candidateStart = slot.cursor;
      if (earliestStart !== null && candidateStart.getTime() < earliestStart.getTime()) {
        candidateStart = earliestStart;
      }
      if (candidateStart.getTime() >= slot.end.getTime()) {
        continue;
      }

      const availableInSlot = Math.floor(
        (slot.end.getTime() - candidateStart.getTime()) / 60000
      );
      if (availableInSlot <= 0) {
        continue;
      }

      const scheduledMins = Math.min(remaining, availableInSlot);
      const blockEnd = new Date(candidateStart.getTime() + scheduledMins * 60000);

      taskBlocks.push({
        task_id: task.task_id!,
        task_title: task.title,
        start: candidateStart.toISOString(),
        end: blockEnd.toISOString(),
        scheduled_minutes: scheduledMins,
      });

      slot.cursor = blockEnd;
      globalCursor = blockEnd;
      earliestStart = blockEnd;
      remaining -= scheduledMins;

      if (remaining === 0) {
        break;
      }
    }

    scheduledBlocks.push(...taskBlocks);
    const scheduledMinutes = task.expected_minutes - remaining;
    const completed = remaining === 0;

    taskSummaries.push({
      task_id: task.task_id!,
      total_required_minutes: task.expected_minutes,
      total_scheduled_minutes: scheduledMinutes,
      completed_in_plan: completed,
    });

    if (completed) {
      completedTasks.add(task.task_id!);
      if (taskBlocks.length > 0) {
        completedEnd.set(
          task.task_id!,
          new Date(taskBlocks[taskBlocks.length - 1].end)
        );
      } else if (earliestStart !== null) {
        completedEnd.set(task.task_id!, earliestStart);
      }
    } else {
      unfinishedTasks.push(task.task_id!);
      warnings.push(
        `${task.task_id} could only be scheduled for ${scheduledMinutes} of ${task.expected_minutes} minutes.`
      );
    }
  }

  const finalEnd =
    scheduledBlocks.length > 0
      ? new Date(scheduledBlocks[scheduledBlocks.length - 1].end)
      : null;

  const deadlineBuffer =
    deadline !== null && finalEnd !== null
      ? Math.floor((deadline.getTime() - finalEnd.getTime()) / 60000)
      : null;

  if (unfinishedTasks.length > 0) {
    warnings.push(`${unfinishedTasks.length} task(s) remain unfinished.`);
  }

  const feasibilityWarnings = [...warnings];
  const feasibility: FeasibilitySummary = {
    available_minutes: availableMinutes,
    optimistic_workload_minutes: optimisticWorkload,
    expected_workload_minutes: expectedWorkload,
    pessimistic_workload_minutes: pessimisticWorkload,
    expected_shortfall_minutes: expectedShortfall,
    optimistic_shortfall_minutes: optimisticShortfall,
    status: calculateStatus(
      optimisticWorkload,
      expectedWorkload,
      pessimisticWorkload,
      availableMinutes
    ),
    warnings: feasibilityWarnings,
  };

  return {
    feasibility,
    scheduled_blocks: scheduledBlocks,
    task_summaries: taskSummaries,
    deadline_buffer_minutes: deadlineBuffer,
    warnings,
    unfinished_tasks: unfinishedTasks,
  };
}
