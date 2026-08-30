from dataclasses import dataclass
from datetime import datetime, timedelta

from models.schemas import (
    AssignmentAnalysis,
    AvailabilityWindow,
    FeasibilityStatus,
    PlanResult,
    ScheduledBlock,
    TaskEstimate,
    TaskScheduleSummary,
)


class PlannerError(ValueError):
    """A deterministic planning input or dependency error."""


@dataclass(frozen=True)
class _TaskNode:
    task: TaskEstimate
    dependency_ids: tuple[str, ...]
    original_index: int


@dataclass
class _CapacitySlot:
    start: datetime
    end: datetime
    cursor: datetime


def normalize_analysis(analysis: AssignmentAnalysis) -> AssignmentAnalysis:
    """Assign deterministic IDs and validate title-based task dependencies."""
    tasks = [
        task.model_copy(update={"task_id": f"task-{index}"})
        for index, task in enumerate(analysis.tasks, start=1)
    ]
    titles: dict[str, str] = {}
    for task in tasks:
        if task.title in titles:
            raise PlannerError(f"Duplicate task title: {task.title!r}.")
        titles[task.title] = task.task_id

    task_ids = {task.task_id for task in tasks}
    dependencies: dict[str, tuple[str, ...]] = {}
    for task in tasks:
        resolved: list[str] = []
        for dependency in task.dependencies:
            dependency_key = dependency.strip()
            dependency_id = titles.get(dependency_key)
            if dependency_id is None and dependency_key in task_ids:
                dependency_id = dependency_key
            if dependency_id is None:
                raise PlannerError(
                    f"Task {task.task_id} references unknown dependency "
                    f"{dependency!r}."
                )
            if dependency_id == task.task_id:
                raise PlannerError(
                    f"Task {task.task_id} cannot depend on itself."
                )
            if dependency_id not in resolved:
                resolved.append(dependency_id)
        dependencies[task.task_id] = tuple(resolved)

    state: dict[str, int] = {task.task_id: 0 for task in tasks}

    def visit(task_id: str) -> None:
        if state[task_id] == 1:
            raise PlannerError("Task dependencies contain a cycle.")
        if state[task_id] == 2:
            return
        state[task_id] = 1
        for dependency_id in dependencies[task_id]:
            visit(dependency_id)
        state[task_id] = 2

    for task in tasks:
        visit(task.task_id)

    return analysis.model_copy(update={"tasks": tasks})


def _ordered_nodes(analysis: AssignmentAnalysis) -> list[_TaskNode]:
    by_id = {task.task_id: task for task in analysis.tasks}
    by_title = {task.title: task.task_id for task in analysis.tasks}
    nodes = [
        _TaskNode(
            task=task,
            dependency_ids=tuple(
                by_title.get(dependency.strip())
                or dependency.strip()
                for dependency in task.dependencies
            ),
            original_index=index,
        )
        for index, task in enumerate(analysis.tasks)
    ]
    nodes_by_id = {node.task.task_id: node for node in nodes}

    # Phase 1: Mandatory tasks
    mandatory_nodes = [node for node in nodes if not node.task.is_optional]
    mandatory_remaining = {
        node.task.task_id: set(
            dep_id for dep_id in node.dependency_ids
            if not nodes_by_id[dep_id].task.is_optional
        )
        for node in mandatory_nodes
    }
    mandatory_ordered: list[_TaskNode] = []

    while mandatory_remaining:
        ready = [
            nodes_by_id[task_id]
            for task_id, dependency_ids in mandatory_remaining.items()
            if not dependency_ids
        ]
        if not ready:
            raise PlannerError("Task dependencies contain a cycle.")
        ready.sort(key=lambda node: node.original_index)
        for node in ready:
            mandatory_ordered.append(node)
            mandatory_remaining.pop(node.task.task_id)
        completed_ids = {node.task.task_id for node in ready}
        for dependency_ids in mandatory_remaining.values():
            dependency_ids.difference_update(completed_ids)

    # Phase 2: Optional tasks
    optional_nodes = [node for node in nodes if node.task.is_optional]
    satisfied_mandatory_ids = {node.task.task_id for node in mandatory_ordered}
    optional_remaining = {
        node.task.task_id: set(
            dep_id for dep_id in node.dependency_ids
            if dep_id not in satisfied_mandatory_ids
        )
        for node in optional_nodes
    }
    optional_ordered: list[_TaskNode] = []

    while optional_remaining:
        ready = [
            nodes_by_id[task_id]
            for task_id, dependency_ids in optional_remaining.items()
            if not dependency_ids
        ]
        if not ready:
            raise PlannerError("Task dependencies contain a cycle.")
        ready.sort(key=lambda node: node.original_index)
        for node in ready:
            optional_ordered.append(node)
            optional_remaining.pop(node.task.task_id)
        completed_ids = {node.task.task_id for node in ready}
        for dependency_ids in optional_remaining.values():
            dependency_ids.difference_update(completed_ids)

    return mandatory_ordered + optional_ordered


def _parse_deadline(analysis: AssignmentAnalysis) -> datetime | None:
    if analysis.deadline_iso is None:
        return None
    return datetime.fromisoformat(analysis.deadline_iso.replace("Z", "+00:00"))


def _capacity_slots(
    availability: list[AvailabilityWindow],
    deadline: datetime | None,
) -> list[_CapacitySlot]:
    windows = sorted(availability, key=lambda window: window.start)
    slots: list[_CapacitySlot] = []
    for window in windows:
        start = window.start
        end = window.end
        if deadline is not None:
            if start >= deadline:
                continue
            end = min(end, deadline)
        if end <= start:
            continue
        if slots and start <= slots[-1].end:
            slots[-1].end = max(slots[-1].end, end)
        else:
            slots.append(_CapacitySlot(start=start, end=end, cursor=start))
    return slots


def _slot_minutes(slots: list[_CapacitySlot]) -> int:
    return sum(
        max(0, int((slot.end - slot.start).total_seconds() // 60))
        for slot in slots
    )


def _status(
    optimistic: int,
    expected: int,
    pessimistic: int,
    available: int,
) -> FeasibilityStatus:
    if pessimistic <= available:
        return "comfortable"
    if expected <= available:
        return "tight"
    if optimistic <= available:
        return "at_risk"
    return "infeasible"


def build_plan(
    analysis: AssignmentAnalysis,
    availability: list[AvailabilityWindow],
) -> PlanResult:
    normalized = normalize_analysis(analysis)
    nodes = _ordered_nodes(normalized)
    deadline = _parse_deadline(normalized)
    slots = _capacity_slots(availability, deadline)
    available_minutes = _slot_minutes(slots)

    mandatory_tasks = [task for task in normalized.tasks if not task.is_optional]
    optimistic_workload = sum(
        task.optimistic_minutes for task in mandatory_tasks
    )
    expected_workload = sum(task.expected_minutes for task in mandatory_tasks)
    pessimistic_workload = sum(
        task.pessimistic_minutes for task in mandatory_tasks
    )
    expected_shortfall = max(expected_workload - available_minutes, 0)
    optimistic_shortfall = max(optimistic_workload - available_minutes, 0)
    warnings: list[str] = []
    if expected_shortfall:
        warnings.append(
            f"Expected workload exceeds available capacity by "
            f"{expected_shortfall} minutes."
        )
    if optimistic_shortfall:
        warnings.append(
            f"Optimistic workload exceeds available capacity by "
            f"{optimistic_shortfall} minutes."
        )

    scheduled_blocks: list[ScheduledBlock] = []
    task_summaries: list[TaskScheduleSummary] = []
    completed_tasks: set[str] = set()
    completed_end: dict[str, datetime] = {}
    unfinished_tasks: list[str] = []
    global_cursor: datetime | None = None

    for node in nodes:
        task = node.task
        missing_dependencies = [
            dependency_id
            for dependency_id in node.dependency_ids
            if dependency_id not in completed_tasks
        ]
        if missing_dependencies:
            unfinished_tasks.append(task.task_id)
            warnings.append(
                f"{task.task_id} was not scheduled because a prerequisite "
                "was unfinished."
            )
            task_summaries.append(
                TaskScheduleSummary(
                    task_id=task.task_id,
                    total_required_minutes=task.expected_minutes,
                    total_scheduled_minutes=0,
                    completed_in_plan=False,
                )
            )
            continue

        if task.is_optional:
            mandatory_incomplete = any(
                t.task_id not in completed_tasks for t in mandatory_tasks
            )
            if expected_workload > available_minutes or mandatory_incomplete:
                unfinished_tasks.append(task.task_id)
                warnings.append(
                    f"{task.task_id} could only be scheduled for 0 of "
                    f"{task.expected_minutes} minutes."
                )
                task_summaries.append(
                    TaskScheduleSummary(
                        task_id=task.task_id,
                        total_required_minutes=task.expected_minutes,
                        total_scheduled_minutes=0,
                        completed_in_plan=False,
                    )
                )
                continue

        dependency_end = max(
            (
                completed_end[dependency_id]
                for dependency_id in node.dependency_ids
                if dependency_id in completed_end
            ),
            default=None,
        )
        earliest_start = dependency_end
        if global_cursor is not None:
            earliest_start = (
                max(earliest_start, global_cursor)
                if earliest_start is not None
                else global_cursor
            )

        remaining = task.expected_minutes
        task_blocks: list[ScheduledBlock] = []
        for slot in slots:
            candidate_start = slot.cursor
            if earliest_start is not None:
                candidate_start = max(candidate_start, earliest_start)
            if candidate_start >= slot.end:
                continue
            available_in_slot = int(
                (slot.end - candidate_start).total_seconds() // 60
            )
            if available_in_slot <= 0:
                continue
            scheduled_minutes = min(remaining, available_in_slot)
            block_end = candidate_start + timedelta(minutes=scheduled_minutes)
            task_blocks.append(
                ScheduledBlock(
                    task_id=task.task_id,
                    task_title=task.title,
                    start=candidate_start,
                    end=block_end,
                    scheduled_minutes=scheduled_minutes,
                )
            )
            slot.cursor = block_end
            global_cursor = block_end
            earliest_start = block_end
            remaining -= scheduled_minutes
            if remaining == 0:
                break

        scheduled_blocks.extend(task_blocks)
        scheduled_minutes = task.expected_minutes - remaining
        completed = remaining == 0
        task_summaries.append(
            TaskScheduleSummary(
                task_id=task.task_id,
                total_required_minutes=task.expected_minutes,
                total_scheduled_minutes=scheduled_minutes,
                completed_in_plan=completed,
            )
        )
        if completed:
            completed_tasks.add(task.task_id)
            if task_blocks:
                completed_end[task.task_id] = task_blocks[-1].end
            elif earliest_start is not None:
                completed_end[task.task_id] = earliest_start
        else:
            unfinished_tasks.append(task.task_id)
            warnings.append(
                f"{task.task_id} could only be scheduled for "
                f"{scheduled_minutes} of {task.expected_minutes} minutes."
            )

    final_end = scheduled_blocks[-1].end if scheduled_blocks else None
    deadline_buffer = (
        int((deadline - final_end).total_seconds() // 60)
        if deadline is not None and final_end is not None
        else None
    )
    if unfinished_tasks:
        warnings.append(f"{len(unfinished_tasks)} task(s) remain unfinished.")

    feasibility_warnings = list(warnings)
    feasibility = {
        "available_minutes": available_minutes,
        "optimistic_workload_minutes": optimistic_workload,
        "expected_workload_minutes": expected_workload,
        "pessimistic_workload_minutes": pessimistic_workload,
        "expected_shortfall_minutes": expected_shortfall,
        "optimistic_shortfall_minutes": optimistic_shortfall,
        "status": _status(
            optimistic_workload,
            expected_workload,
            pessimistic_workload,
            available_minutes,
        ),
        "warnings": feasibility_warnings,
    }
    return PlanResult(
        feasibility=feasibility,
        scheduled_blocks=scheduled_blocks,
        task_summaries=task_summaries,
        deadline_buffer_minutes=deadline_buffer,
        warnings=warnings,
        unfinished_tasks=unfinished_tasks,
    )