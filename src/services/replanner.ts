import {
  AssignmentAnalysis,
  AvailabilityWindow,
  PlanChange,
  PlanResult,
  ReplanChangeType,
  ReplanResponse,
  ScheduledBlock,
  TaskScheduleSummary,
} from '../types.js';
import {
  CapacitySlot,
  PlannerError,
  buildPlan,
  calculateStatus,
  capacitySlots,
  normalizeAnalysis,
  orderedNodes,
  parseDeadline,
} from './planner.js';

function blocksByTask(
  blocks: ScheduledBlock[]
): Map<string, ScheduledBlock[]> {
  const grouped = new Map<string, ScheduledBlock[]>();
  for (const block of blocks) {
    if (!grouped.has(block.task_id)) {
      grouped.set(block.task_id, []);
    }
    grouped.get(block.task_id)!.push(block);
  }
  for (const taskBlocks of grouped.values()) {
    taskBlocks.sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
  }
  return grouped;
}

function areBlocksEqual(a: ScheduledBlock, b: ScheduledBlock): boolean {
  return (
    a.task_id === b.task_id &&
    a.task_title === b.task_title &&
    new Date(a.start).getTime() === new Date(b.start).getTime() &&
    new Date(a.end).getTime() === new Date(b.end).getTime() &&
    a.scheduled_minutes === b.scheduled_minutes
  );
}

function areBlockListsEqual(
  a: ScheduledBlock[],
  b: ScheduledBlock[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!areBlocksEqual(a[i], b[i])) return false;
  }
  return true;
}

export function validatePreviousPlan(
  analysis: AssignmentAnalysis,
  previousPlan: PlanResult
): Map<string, ScheduledBlock[]> {
  const taskById = new Map(analysis.tasks.map((t) => [t.task_id!, t]));
  const grouped = blocksByTask(previousPlan.scheduled_blocks || []);

  for (const block of previousPlan.scheduled_blocks || []) {
    const task = taskById.get(block.task_id);
    if (!task) {
      throw new PlannerError(
        `Previous plan references unknown task ${JSON.stringify(block.task_id)}.`
      );
    }
    if (block.task_title !== task.title) {
      throw new PlannerError(
        `Previous plan title does not match task ${block.task_id}.`
      );
    }
  }

  const orderedBlocks = [...(previousPlan.scheduled_blocks || [])].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  for (let i = 0; i < orderedBlocks.length - 1; i++) {
    const prev = orderedBlocks[i];
    const curr = orderedBlocks[i + 1];
    if (new Date(curr.start).getTime() < new Date(prev.end).getTime()) {
      throw new PlannerError('Previous plan contains overlapping blocks.');
    }
  }

  const summaries = new Map(
    (previousPlan.task_summaries || []).map((s) => [s.task_id, s])
  );

  if (
    summaries.size !== (previousPlan.task_summaries || []).length ||
    summaries.size !== taskById.size
  ) {
    throw new PlannerError(
      'Previous plan summaries do not match the analysis tasks.'
    );
  }

  for (const taskId of taskById.keys()) {
    if (!summaries.has(taskId)) {
      throw new PlannerError(
        'Previous plan summaries do not match the analysis tasks.'
      );
    }
  }

  const incompleteTaskIds = new Set<string>();

  for (const [taskId, task] of taskById.entries()) {
    const taskBlocks = grouped.get(taskId) || [];
    const scheduledMinutes = taskBlocks.reduce(
      (sum, b) => sum + b.scheduled_minutes,
      0
    );

    if (scheduledMinutes > task.expected_minutes) {
      throw new PlannerError(
        `Previous plan schedules too much work for ${taskId}.`
      );
    }

    const summary = summaries.get(taskId)!;
    if (summary.total_required_minutes !== task.expected_minutes) {
      throw new PlannerError(
        `Previous plan duration does not match ${taskId}.`
      );
    }
    if (summary.total_scheduled_minutes !== scheduledMinutes) {
      throw new PlannerError(
        `Previous plan summary does not match blocks for ${taskId}.`
      );
    }
    if (summary.completed_in_plan !== (scheduledMinutes === task.expected_minutes)) {
      throw new PlannerError(
        `Previous plan completion state does not match ${taskId}.`
      );
    }
    if (!summary.completed_in_plan) {
      incompleteTaskIds.add(taskId);
    }
  }

  const unfinishedSet = new Set(previousPlan.unfinished_tasks || []);
  if (
    unfinishedSet.size !== (previousPlan.unfinished_tasks || []).length ||
    unfinishedSet.size !== incompleteTaskIds.size
  ) {
    throw new PlannerError(
      'Previous plan unfinished tasks do not match its task summaries.'
    );
  }

  for (const unfinId of unfinishedSet) {
    if (!incompleteTaskIds.has(unfinId)) {
      throw new PlannerError(
        'Previous plan unfinished tasks do not match its task summaries.'
      );
    }
  }

  const mandatoryTasks = analysis.tasks.filter((t) => !t.is_optional);
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

  const feas = previousPlan.feasibility;
  if (
    feas.optimistic_workload_minutes !== optimisticWorkload ||
    feas.expected_workload_minutes !== expectedWorkload ||
    feas.pessimistic_workload_minutes !== pessimisticWorkload ||
    feas.expected_shortfall_minutes !==
      Math.max(0, expectedWorkload - feas.available_minutes) ||
    feas.optimistic_shortfall_minutes !==
      Math.max(0, optimisticWorkload - feas.available_minutes) ||
    feas.status !==
      calculateStatus(
        optimisticWorkload,
        expectedWorkload,
        pessimisticWorkload,
        feas.available_minutes
      )
  ) {
    throw new PlannerError(
      'Previous plan feasibility metadata is inconsistent.'
    );
  }

  const deadline = parseDeadline(analysis);
  if (deadline !== null) {
    for (const block of previousPlan.scheduled_blocks || []) {
      if (new Date(block.end).getTime() > deadline.getTime()) {
        throw new PlannerError(
          'Previous plan contains work after the deadline.'
        );
      }
    }
  }

  const finalEnd =
    orderedBlocks.length > 0
      ? new Date(orderedBlocks[orderedBlocks.length - 1].end)
      : null;
  const expectedBuffer =
    deadline !== null && finalEnd !== null
      ? Math.floor((deadline.getTime() - finalEnd.getTime()) / 60000)
      : null;

  if (previousPlan.deadline_buffer_minutes !== expectedBuffer) {
    throw new PlannerError(
      'Previous plan deadline buffer is inconsistent.'
    );
  }

  const nodes = orderedNodes(analysis);
  for (const node of nodes) {
    const taskBlocks = grouped.get(node.task.task_id!) || [];
    if (taskBlocks.length === 0) {
      continue;
    }

    for (const dependencyId of node.dependencyIds) {
      const dependencyBlocks = grouped.get(dependencyId) || [];
      const dependency = taskById.get(dependencyId)!;
      const dependencyMinutes = dependencyBlocks.reduce(
        (sum, b) => sum + b.scheduled_minutes,
        0
      );

      if (dependencyMinutes < dependency.expected_minutes) {
        throw new PlannerError(
          `Previous plan schedules ${node.task.task_id} before an unfinished prerequisite.`
        );
      }

      if (dependency.expected_minutes === 0 && dependencyBlocks.length === 0) {
        continue;
      }

      const dependencyEnd = Math.max(
        ...dependencyBlocks.map((b) => new Date(b.end).getTime())
      );
      const taskStart = Math.min(
        ...taskBlocks.map((b) => new Date(b.start).getTime())
      );

      if (taskStart < dependencyEnd) {
        throw new PlannerError(
          `Previous plan violates dependency order for ${node.task.task_id}.`
        );
      }
    }
  }

  return grouped;
}

function blockFits(block: ScheduledBlock, slots: CapacitySlot[]): boolean {
  const bStart = new Date(block.start).getTime();
  const bEnd = new Date(block.end).getTime();

  return slots.some(
    (slot) => bStart >= slot.start.getTime() && bEnd <= slot.end.getTime()
  );
}

function preservedBlocks(
  analysis: AssignmentAnalysis,
  previousPlan: PlanResult,
  slots: CapacitySlot[]
): {
  preserved: Map<string, ScheduledBlock[]>;
  reasons: Map<string, string>;
} {
  const preserved = new Map<string, ScheduledBlock[]>();
  const reasons = new Map<string, string>();

  for (const block of previousPlan.scheduled_blocks || []) {
    if (blockFits(block, slots)) {
      if (!preserved.has(block.task_id)) {
        preserved.set(block.task_id, []);
      }
      preserved.get(block.task_id)!.push(block);
    } else {
      reasons.set(block.task_id, 'availability');
    }
  }

  const taskById = new Map(analysis.tasks.map((t) => [t.task_id!, t]));
  for (const taskBlocks of preserved.values()) {
    taskBlocks.sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
  }

  let changed = true;
  const nodes = orderedNodes(analysis);

  while (changed) {
    changed = false;
    for (const node of nodes) {
      const taskId = node.task.task_id!;
      const taskBlocks = preserved.get(taskId) || [];
      if (taskBlocks.length === 0) {
        continue;
      }

      for (const dependencyId of node.dependencyIds) {
        const dependency = taskById.get(dependencyId)!;
        const depBlocks = preserved.get(dependencyId) || [];
        if (dependency.expected_minutes === 0 && depBlocks.length === 0) {
          continue;
        }

        const depMinutes = depBlocks.reduce(
          (sum, b) => sum + b.scheduled_minutes,
          0
        );
        const depEnd =
          depBlocks.length > 0
            ? Math.max(...depBlocks.map((b) => new Date(b.end).getTime()))
            : null;
        const taskStart = Math.min(
          ...taskBlocks.map((b) => new Date(b.start).getTime())
        );

        if (
          depMinutes < dependency.expected_minutes ||
          depEnd === null ||
          taskStart < depEnd
        ) {
          preserved.delete(taskId);
          reasons.set(taskId, 'dependency');
          changed = true;
          break;
        }
      }
    }
  }

  return { preserved, reasons };
}

function freeSlots(
  slots: CapacitySlot[],
  allPreserved: ScheduledBlock[]
): CapacitySlot[] {
  const occupied = [...allPreserved].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );
  const free: CapacitySlot[] = [];

  for (const slot of slots) {
    let cursor = new Date(slot.start.getTime());

    for (const block of occupied) {
      const bStart = new Date(block.start);
      const bEnd = new Date(block.end);

      if (bEnd.getTime() <= cursor.getTime()) {
        continue;
      }
      if (bStart.getTime() >= slot.end.getTime()) {
        break;
      }
      if (bStart.getTime() > cursor.getTime()) {
        const end = new Date(
          Math.min(bStart.getTime(), slot.end.getTime())
        );
        free.push({
          start: new Date(cursor.getTime()),
          end,
          cursor: new Date(cursor.getTime()),
        });
      }
      cursor = new Date(Math.max(cursor.getTime(), bEnd.getTime()));
      if (cursor.getTime() >= slot.end.getTime()) {
        break;
      }
    }

    if (cursor.getTime() < slot.end.getTime()) {
      free.push({
        start: new Date(cursor.getTime()),
        end: new Date(slot.end.getTime()),
        cursor: new Date(cursor.getTime()),
      });
    }
  }

  return free;
}

function scheduleRemaining(
  analysis: AssignmentAnalysis,
  preserved: Map<string, ScheduledBlock[]>,
  slots: CapacitySlot[]
): {
  scheduled: Map<string, ScheduledBlock[]>;
  unfinished: string[];
} {
  const scheduled = new Map<string, ScheduledBlock[]>();
  for (const [taskId, blocks] of preserved.entries()) {
    scheduled.set(taskId, [...blocks]);
  }

  const completedTasks = new Set<string>();
  const completedEnd = new Map<string, Date>();
  const unfinished: string[] = [];
  let globalCursor: Date | null = null;

  const nodes = orderedNodes(analysis);

  for (const node of nodes) {
    const task = node.task;
    const taskId = task.task_id!;
    if (!scheduled.has(taskId)) {
      scheduled.set(taskId, []);
    }
    const existing = scheduled.get(taskId)!;
    const existingMinutes = existing.reduce(
      (sum, b) => sum + b.scheduled_minutes,
      0
    );

    const missingDeps = node.dependencyIds.filter(
      (depId) => !completedTasks.has(depId)
    );
    if (missingDeps.length > 0) {
      unfinished.push(taskId);
      continue;
    }

    const mandatoryTasks = analysis.tasks.filter((t) => !t.is_optional);
    if (task.is_optional) {
      const mandatoryIncomplete = mandatoryTasks.some(
        (t) => !completedTasks.has(t.task_id!)
      );
      if (mandatoryIncomplete) {
        if (existingMinutes < task.expected_minutes) {
          unfinished.push(taskId);
        } else {
          completedTasks.add(taskId);
        }
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

    let remaining = Math.max(0, task.expected_minutes - existingMinutes);

    if (remaining > 0) {
      for (const slot of slots) {
        let candidateStart = slot.cursor;
        if (
          earliestStart !== null &&
          candidateStart.getTime() < earliestStart.getTime()
        ) {
          candidateStart = earliestStart;
        }
        if (candidateStart.getTime() >= slot.end.getTime()) {
          continue;
        }

        const availableMins = Math.floor(
          (slot.end.getTime() - candidateStart.getTime()) / 60000
        );
        if (availableMins <= 0) {
          continue;
        }

        const scheduledMins = Math.min(remaining, availableMins);
        const blockEnd = new Date(
          candidateStart.getTime() + scheduledMins * 60000
        );

        existing.push({
          task_id: taskId,
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
    }

    existing.sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
    const totalScheduled = existing.reduce(
      (sum, b) => sum + b.scheduled_minutes,
      0
    );

    if (totalScheduled === task.expected_minutes) {
      completedTasks.add(taskId);
      if (existing.length > 0) {
        const lastEnd = new Date(existing[existing.length - 1].end);
        completedEnd.set(taskId, lastEnd);
        globalCursor =
          globalCursor !== null
            ? new Date(Math.max(globalCursor.getTime(), lastEnd.getTime()))
            : lastEnd;
      } else {
        const compDate = earliestStart || globalCursor;
        if (compDate) {
          completedEnd.set(taskId, compDate);
        }
      }
    } else {
      unfinished.push(taskId);
      if (existing.length > 0) {
        const lastEnd = new Date(existing[existing.length - 1].end);
        globalCursor =
          globalCursor !== null
            ? new Date(Math.max(globalCursor.getTime(), lastEnd.getTime()))
            : lastEnd;
      }
    }
  }

  return { scheduled, unfinished };
}

function calculateTaskSummaries(
  analysis: AssignmentAnalysis,
  blocksByTaskId: Map<string, ScheduledBlock[]>
): TaskScheduleSummary[] {
  return analysis.tasks.map((task) => {
    const blocks = blocksByTaskId.get(task.task_id!) || [];
    const totalScheduled = blocks.reduce(
      (sum, b) => sum + b.scheduled_minutes,
      0
    );
    return {
      task_id: task.task_id!,
      total_required_minutes: task.expected_minutes,
      total_scheduled_minutes: totalScheduled,
      completed_in_plan: totalScheduled === task.expected_minutes,
    };
  });
}

function determineChangeType(
  oldBlocks: ScheduledBlock[],
  newBlocks: ScheduledBlock[],
  reasonKey?: string,
  expectedMinutes?: number
): { change_type: ReplanChangeType; reason: string } {
  const newTotalMinutes = newBlocks.reduce(
    (sum, b) => sum + b.scheduled_minutes,
    0
  );
  const isPartiallyScheduled =
    expectedMinutes !== undefined &&
    newBlocks.length > 0 &&
    newTotalMinutes < expectedMinutes;

  if (
    oldBlocks.length > 0 &&
    areBlockListsEqual(oldBlocks, newBlocks) &&
    !isPartiallyScheduled
  ) {
    return {
      change_type: 'preserved',
      reason: 'Existing blocks still satisfy the new constraints.',
    };
  }

  if (newBlocks.length === 0) {
    if (reasonKey === 'dependency') {
      return {
        change_type: 'unscheduled',
        reason:
          'A prerequisite changed, so this task could not be rescheduled.',
      };
    }
    return {
      change_type: 'unscheduled',
      reason: 'Insufficient remaining capacity before the deadline.',
    };
  }

  if (isPartiallyScheduled) {
    return {
      change_type: 'partially_rescheduled',
      reason: `Only ${newTotalMinutes} of ${expectedMinutes} minutes fit under the new availability.`,
    };
  }

  if (newBlocks.length > 1) {
    return {
      change_type: 'split',
      reason:
        'The task now spans multiple scheduled blocks after replanning.',
    };
  }

  if (reasonKey === 'dependency') {
    return {
      change_type: 'rescheduled',
      reason: 'A prerequisite changed, so this task had to be rescheduled.',
    };
  }

  if (oldBlocks.length > 0) {
    return {
      change_type: 'moved',
      reason: 'The previous block no longer fits the new availability.',
    };
  }

  return {
    change_type: 'rescheduled',
    reason:
      'Remaining work was scheduled into the new availability windows.',
  };
}

export function replan(
  analysis: AssignmentAnalysis,
  previousPlan: PlanResult,
  newAvailability: AvailabilityWindow[]
): ReplanResponse {
  const normalized = normalizeAnalysis(analysis);
  const previousBlocksByTask = validatePreviousPlan(
    normalized,
    previousPlan
  );

  const deadline = parseDeadline(normalized);
  const slots = capacitySlots(newAvailability, deadline);
  const { preserved, reasons: reasonKeys } = preservedBlocks(
    normalized,
    previousPlan,
    slots
  );

  const allPreservedBlocks = Array.from(preserved.values()).flat();
  const free = freeSlots(slots, allPreservedBlocks);

  const { scheduled: scheduledByTask, unfinished: unfinishedTasks } =
    scheduleRemaining(normalized, preserved, free);

  const newBlocks = Array.from(scheduledByTask.values())
    .flat()
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const newBlocksByTaskId = blocksByTask(newBlocks);

  const basePlan = buildPlan(normalized, newAvailability);
  const warnings = [...basePlan.feasibility.warnings];

  if (unfinishedTasks.length > 0) {
    warnings.push(
      `${unfinishedTasks.length} task(s) remain unfinished after replanning.`
    );
  }

  const previousStatus = previousPlan.feasibility.status;
  const newStatus = basePlan.feasibility.status;
  if (previousStatus !== newStatus) {
    warnings.push(
      `Feasibility changed from ${previousStatus} to ${newStatus}.`
    );
  }

  const finalEnd =
    newBlocks.length > 0
      ? new Date(newBlocks[newBlocks.length - 1].end)
      : null;

  const newDeadlineBuffer =
    deadline !== null && finalEnd !== null
      ? Math.floor((deadline.getTime() - finalEnd.getTime()) / 60000)
      : null;

  const previousBuffer = previousPlan.deadline_buffer_minutes;
  const hasUnfinishedMandatory = unfinishedTasks.some(
    (id) => !normalized.tasks.find((t) => t.task_id === id)?.is_optional
  );

  if (
    !hasUnfinishedMandatory &&
    previousBuffer !== null &&
    newDeadlineBuffer !== null &&
    previousBuffer !== newDeadlineBuffer
  ) {
    const direction =
      newDeadlineBuffer < previousBuffer ? 'decreased' : 'increased';
    warnings.push(
      `Deadline buffer ${direction} from ${previousBuffer} minutes to ${newDeadlineBuffer} minutes.`
    );
  }

  if (
    previousPlan.feasibility.expected_shortfall_minutes === 0 &&
    basePlan.feasibility.expected_shortfall_minutes > 0
  ) {
    warnings.push(
      'Expected workload no longer fits within available capacity.'
    );
  }

  const changes: PlanChange[] = [];
  let preservedCount = 0;
  let changedCount = 0;

  for (const task of normalized.tasks) {
    const oldBlocks = previousBlocksByTask.get(task.task_id!) || [];
    const taskNewBlocks = newBlocksByTaskId.get(task.task_id!) || [];

    let taskPreservedCount = 0;
    for (const oldBlock of oldBlocks) {
      if (taskNewBlocks.some((newBlock) => areBlocksEqual(oldBlock, newBlock))) {
        taskPreservedCount++;
      }
    }

    preservedCount += taskPreservedCount;
    if (oldBlocks.length > 0) {
      changedCount += oldBlocks.length - taskPreservedCount;
    } else if (taskNewBlocks.length > 0) {
      changedCount += taskNewBlocks.length;
    }

    const { change_type, reason } = determineChangeType(
      oldBlocks,
      taskNewBlocks,
      reasonKeys.get(task.task_id!),
      task.expected_minutes
    );

    changes.push({
      task_id: task.task_id!,
      task_title: task.title,
      change_type,
      old_blocks: oldBlocks,
      new_blocks: taskNewBlocks,
      reason,
    });
  }

  const taskSummaries = calculateTaskSummaries(normalized, newBlocksByTaskId);
  const candidatePlan: PlanResult = {
    feasibility: basePlan.feasibility,
    scheduled_blocks: newBlocks,
    task_summaries: taskSummaries,
    deadline_buffer_minutes: newDeadlineBuffer,
    warnings,
    unfinished_tasks: unfinishedTasks,
  };

  validatePreviousPlan(normalized, candidatePlan);

  return {
    feasibility: {
      ...basePlan.feasibility,
      warnings,
    },
    scheduled_blocks: newBlocks,
    task_summaries: taskSummaries,
    deadline_buffer_minutes: newDeadlineBuffer,
    changes,
    preserved_block_count: preservedCount,
    changed_block_count: changedCount,
    warnings,
    unfinished_tasks: unfinishedTasks,
    previous_status: previousStatus,
    new_status: newStatus,
    previous_deadline_buffer_minutes: previousBuffer,
    new_deadline_buffer_minutes: newDeadlineBuffer,
  };
}
