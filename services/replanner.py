from datetime import datetime, timedelta

from models.schemas import (
    AssignmentAnalysis,
    AvailabilityWindow,
    PlanResult,
    PlanChange,
    ReplanResponse,
    ScheduledBlock,
    TaskScheduleSummary,
)

from .planner import (
    PlannerError,
    _CapacitySlot,
    _TaskNode,
    _capacity_slots,
    _ordered_nodes,
    _status,
    build_plan,
    normalize_analysis,
)


def _blocks_by_task(blocks: list[ScheduledBlock]) -> dict[str, list[ScheduledBlock]]:
    grouped: dict[str, list[ScheduledBlock]] = {}
    for block in blocks:
        grouped.setdefault(block.task_id, []).append(block)
    for task_blocks in grouped.values():
        task_blocks.sort(key=lambda block: block.start)
    return grouped


def _validate_previous_plan(
    analysis: AssignmentAnalysis,
    previous_plan: PlanResult,
) -> dict[str, list[ScheduledBlock]]:
    task_by_id = {task.task_id: task for task in analysis.tasks}
    grouped = _blocks_by_task(previous_plan.scheduled_blocks)
    for block in previous_plan.scheduled_blocks:
        task = task_by_id.get(block.task_id)
        if task is None:
            raise PlannerError(
                f"Previous plan references unknown task {block.task_id!r}."
            )
        if block.task_title != task.title:
            raise PlannerError(
                f"Previous plan title does not match task {block.task_id}."
            )

    ordered_blocks = sorted(
        previous_plan.scheduled_blocks,
        key=lambda block: block.start,
    )
    for previous, current in zip(ordered_blocks, ordered_blocks[1:]):
        if current.start < previous.end:
            raise PlannerError("Previous plan contains overlapping blocks.")

    summaries = {summary.task_id: summary for summary in previous_plan.task_summaries}
    if (
        len(summaries) != len(previous_plan.task_summaries)
        or set(summaries) != set(task_by_id)
    ):
        raise PlannerError("Previous plan summaries do not match the analysis tasks.")
    incomplete_task_ids: set[str] = set()
    for task_id, task in task_by_id.items():
        scheduled_minutes = sum(
            block.scheduled_minutes for block in grouped.get(task_id, [])
        )
        if scheduled_minutes > task.expected_minutes:
            raise PlannerError(
                f"Previous plan schedules too much work for {task_id}."
            )
        summary = summaries[task_id]
        if summary.total_required_minutes != task.expected_minutes:
            raise PlannerError(
                f"Previous plan duration does not match {task_id}."
            )
        if summary.total_scheduled_minutes != scheduled_minutes:
            raise PlannerError(
                f"Previous plan summary does not match blocks for {task_id}."
            )
        if summary.completed_in_plan != (
            scheduled_minutes == task.expected_minutes
        ):
            raise PlannerError(
                f"Previous plan completion state does not match {task_id}."
            )
        if not summary.completed_in_plan:
            incomplete_task_ids.add(task_id)

    if (
        len(set(previous_plan.unfinished_tasks))
        != len(previous_plan.unfinished_tasks)
        or set(previous_plan.unfinished_tasks) != incomplete_task_ids
    ):
        raise PlannerError(
            "Previous plan unfinished tasks do not match its task summaries."
        )

    optimistic_workload = sum(
        task.optimistic_minutes for task in analysis.tasks
    )
    expected_workload = sum(task.expected_minutes for task in analysis.tasks)
    pessimistic_workload = sum(
        task.pessimistic_minutes for task in analysis.tasks
    )
    feasibility = previous_plan.feasibility
    if (
        feasibility.optimistic_workload_minutes != optimistic_workload
        or feasibility.expected_workload_minutes != expected_workload
        or feasibility.pessimistic_workload_minutes != pessimistic_workload
        or feasibility.expected_shortfall_minutes
        != max(expected_workload - feasibility.available_minutes, 0)
        or feasibility.optimistic_shortfall_minutes
        != max(optimistic_workload - feasibility.available_minutes, 0)
        or feasibility.status
        != _status(
            optimistic_workload,
            expected_workload,
            pessimistic_workload,
            feasibility.available_minutes,
        )
    ):
        raise PlannerError(
            "Previous plan feasibility metadata is inconsistent."
        )

    deadline = (
        datetime.fromisoformat(analysis.deadline_iso.replace("Z", "+00:00"))
        if analysis.deadline_iso is not None
        else None
    )
    if deadline is not None and any(
        block.end > deadline for block in previous_plan.scheduled_blocks
    ):
        raise PlannerError("Previous plan contains work after the deadline.")
    final_end = ordered_blocks[-1].end if ordered_blocks else None
    expected_buffer = (
        int((deadline - final_end).total_seconds() // 60)
        if deadline is not None and final_end is not None
        else None
    )
    if previous_plan.deadline_buffer_minutes != expected_buffer:
        raise PlannerError(
            "Previous plan deadline buffer is inconsistent."
        )

    for node in _ordered_nodes(analysis):
        task_blocks = grouped.get(node.task.task_id, [])
        if not task_blocks:
            continue
        for dependency_id in node.dependency_ids:
            dependency_blocks = grouped.get(dependency_id, [])
            dependency = task_by_id[dependency_id]
            dependency_minutes = sum(
                block.scheduled_minutes for block in dependency_blocks
            )
            if dependency_minutes < dependency.expected_minutes:
                raise PlannerError(
                    f"Previous plan schedules {node.task.task_id} before an "
                    f"unfinished prerequisite."
                )
            if dependency.expected_minutes == 0 and not dependency_blocks:
                continue
            dependency_end = max(
                block.end for block in dependency_blocks
            )
            if min(block.start for block in task_blocks) < dependency_end:
                raise PlannerError(
                    f"Previous plan violates dependency order for "
                    f"{node.task.task_id}."
                )
    return grouped


def _block_fits(
    block: ScheduledBlock,
    slots: list[_CapacitySlot],
) -> bool:
    return any(
        block.start >= slot.start and block.end <= slot.end
        for slot in slots
    )


def _preserved_blocks(
    analysis: AssignmentAnalysis,
    previous_plan: PlanResult,
    slots: list[_CapacitySlot],
) -> tuple[dict[str, list[ScheduledBlock]], dict[str, str]]:
    preserved: dict[str, list[ScheduledBlock]] = {}
    reasons: dict[str, str] = {}
    for block in previous_plan.scheduled_blocks:
        if _block_fits(block, slots):
            preserved.setdefault(block.task_id, []).append(block)
        else:
            reasons[block.task_id] = "availability"

    task_by_id = {task.task_id: task for task in analysis.tasks}
    for task_blocks in preserved.values():
        task_blocks.sort(key=lambda block: block.start)
    changed = True
    nodes = _ordered_nodes(analysis)
    while changed:
        changed = False
        for node in nodes:
            task_blocks = preserved.get(node.task.task_id, [])
            if not task_blocks:
                continue
            for dependency_id in node.dependency_ids:
                dependency = task_by_id[dependency_id]
                dependency_blocks = preserved.get(dependency_id, [])
                if dependency.expected_minutes == 0 and not dependency_blocks:
                    continue
                dependency_minutes = sum(
                    block.scheduled_minutes for block in dependency_blocks
                )
                dependency_end = (
                    max(block.end for block in dependency_blocks)
                    if dependency_blocks
                    else None
                )
                if (
                    dependency_minutes < dependency.expected_minutes
                    or dependency_end is None
                    or min(block.start for block in task_blocks) < dependency_end
                ):
                    preserved.pop(node.task.task_id)
                    reasons[node.task.task_id] = "dependency"
                    changed = True
                    break
    return preserved, reasons


def _free_slots(
    slots: list[_CapacitySlot],
    preserved_blocks: list[ScheduledBlock],
) -> list[_CapacitySlot]:
    occupied = sorted(preserved_blocks, key=lambda block: block.start)
    free: list[_CapacitySlot] = []
    for slot in slots:
        cursor = slot.start
        for block in occupied:
            if block.end <= cursor:
                continue
            if block.start >= slot.end:
                break
            if block.start > cursor:
                free.append(
                    _CapacitySlot(
                        start=cursor,
                        end=min(block.start, slot.end),
                        cursor=cursor,
                    )
                )
            cursor = max(cursor, block.end)
            if cursor >= slot.end:
                break
        if cursor < slot.end:
            free.append(
                _CapacitySlot(start=cursor, end=slot.end, cursor=cursor)
            )
    return free


def _schedule_remaining(
    analysis: AssignmentAnalysis,
    preserved: dict[str, list[ScheduledBlock]],
    free_slots: list[_CapacitySlot],
) -> tuple[dict[str, list[ScheduledBlock]], list[str]]:
    task_by_id = {task.task_id: task for task in analysis.tasks}
    scheduled = {
        task_id: list(task_blocks)
        for task_id, task_blocks in preserved.items()
    }
    completed_tasks: set[str] = set()
    completed_end: dict[str, datetime] = {}
    unfinished: list[str] = []
    global_cursor: datetime | None = None

    for node in _ordered_nodes(analysis):
        task = node.task
        existing = scheduled.setdefault(task.task_id, [])
        existing_minutes = sum(block.scheduled_minutes for block in existing)
        missing_dependencies = [
            dependency_id
            for dependency_id in node.dependency_ids
            if dependency_id not in completed_tasks
        ]
        if missing_dependencies:
            unfinished.append(task.task_id)
            continue

        dependency_end = max(
            (
                completed_end[dependency_id]
                for dependency_id in node.dependency_ids
                if dependency_id in completed_end
            ),
            default=None,
        )
        earliest_start = max(
            (
                start
                for start in (dependency_end, global_cursor)
                if start is not None
            ),
            default=None,
        )
        remaining = max(task.expected_minutes - existing_minutes, 0)
        for slot in free_slots if remaining > 0 else []:
            candidate_start = slot.cursor
            if earliest_start is not None:
                candidate_start = max(candidate_start, earliest_start)
            if candidate_start >= slot.end:
                continue
            available_minutes = int(
                (slot.end - candidate_start).total_seconds() // 60
            )
            if available_minutes <= 0:
                continue
            scheduled_minutes = min(remaining, available_minutes)
            block_end = candidate_start + timedelta(minutes=scheduled_minutes)
            existing.append(
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

        existing.sort(key=lambda block: block.start)
        total_scheduled = sum(block.scheduled_minutes for block in existing)
        if total_scheduled == task.expected_minutes:
            completed_tasks.add(task.task_id)
            completed_end[task.task_id] = max(
                block.end for block in existing
            ) if existing else (earliest_start or global_cursor)
            if completed_end[task.task_id] is not None:
                global_cursor = max(
                    global_cursor or completed_end[task.task_id],
                    completed_end[task.task_id],
                )
        else:
            unfinished.append(task.task_id)
            if existing:
                global_cursor = max(
                    global_cursor or existing[-1].end,
                    existing[-1].end,
                )
    return scheduled, unfinished


def _task_summaries(
    analysis: AssignmentAnalysis,
    blocks_by_task: dict[str, list[ScheduledBlock]],
) -> list[TaskScheduleSummary]:
    return [
        TaskScheduleSummary(
            task_id=task.task_id,
            total_required_minutes=task.expected_minutes,
            total_scheduled_minutes=sum(
                block.scheduled_minutes
                for block in blocks_by_task.get(task.task_id, [])
            ),
            completed_in_plan=sum(
                block.scheduled_minutes
                for block in blocks_by_task.get(task.task_id, [])
            ) == task.expected_minutes,
        )
        for task in analysis.tasks
    ]


def _change_type(
    old_blocks: list[ScheduledBlock],
    new_blocks: list[ScheduledBlock],
    reason_key: str | None,
    expected_minutes: int | None = None,
) -> tuple[str, str]:
    new_total_minutes = sum(b.scheduled_minutes for b in new_blocks)
    is_partially_scheduled = (
        expected_minutes is not None
        and len(new_blocks) > 0
        and new_total_minutes < expected_minutes
    )

    if old_blocks == new_blocks and old_blocks and not is_partially_scheduled:
        return (
            "preserved",
            "Existing blocks still satisfy the new constraints.",
        )
    if not new_blocks:
        if reason_key == "dependency":
            return (
                "unscheduled",
                "A prerequisite changed, so this task could not be rescheduled.",
            )
        return (
            "unscheduled",
            "Insufficient remaining capacity before the deadline.",
        )
    if is_partially_scheduled:
        return (
            "partially_rescheduled",
            f"Only {new_total_minutes} of {expected_minutes} minutes fit under the new availability.",
        )
    if len(new_blocks) > 1:
        return (
            "split",
            "The task now spans multiple scheduled blocks after replanning.",
        )
    if reason_key == "dependency":
        return (
            "rescheduled",
            "A prerequisite changed, so this task had to be rescheduled.",
        )
    if old_blocks:
        return (
            "moved",
            "The previous block no longer fits the new availability.",
        )
    return (
        "rescheduled",
        "Remaining work was scheduled into the new availability windows.",
    )


def replan(
    analysis: AssignmentAnalysis,
    previous_plan: PlanResult,
    new_availability: list[AvailabilityWindow],
) -> ReplanResponse:
    normalized = normalize_analysis(analysis)
    previous_blocks_by_task = _validate_previous_plan(
        normalized,
        previous_plan,
    )
    deadline = (
        datetime.fromisoformat(normalized.deadline_iso.replace("Z", "+00:00"))
        if normalized.deadline_iso is not None
        else None
    )
    slots = _capacity_slots(new_availability, deadline)
    preserved, reason_keys = _preserved_blocks(
        normalized,
        previous_plan,
        slots,
    )
    all_preserved_blocks = [
        block
        for task_blocks in preserved.values()
        for block in task_blocks
    ]
    free_slots = _free_slots(slots, all_preserved_blocks)
    scheduled_by_task, unfinished_tasks = _schedule_remaining(
        normalized,
        preserved,
        free_slots,
    )
    new_blocks = sorted(
        (
            block
            for task_blocks in scheduled_by_task.values()
            for block in task_blocks
        ),
        key=lambda block: block.start,
    )
    new_blocks_by_task = _blocks_by_task(new_blocks)

    base_plan = build_plan(normalized, new_availability)
    warnings = list(base_plan.feasibility.warnings)
    if unfinished_tasks:
        warnings.append(
            f"{len(unfinished_tasks)} task(s) remain unfinished after replanning."
        )
    previous_status = previous_plan.feasibility.status
    new_status = base_plan.feasibility.status
    if previous_status != new_status:
        warnings.append(
            f"Feasibility changed from {previous_status} to {new_status}."
        )

    final_end = new_blocks[-1].end if new_blocks else None
    new_deadline_buffer = (
        int((deadline - final_end).total_seconds() // 60)
        if deadline is not None and final_end is not None
        else None
    )
    previous_buffer = previous_plan.deadline_buffer_minutes
    has_unfinished_mandatory = any(
        not t.is_optional
        for t in normalized.tasks
        if t.task_id in unfinished_tasks
    )
    if (
        not has_unfinished_mandatory
        and previous_buffer is not None
        and new_deadline_buffer is not None
        and previous_buffer != new_deadline_buffer
    ):
        direction = "decreased" if new_deadline_buffer < previous_buffer else "increased"
        warnings.append(
            f"Deadline buffer {direction} from {previous_buffer} minutes "
            f"to {new_deadline_buffer} minutes."
        )
    if (
        previous_plan.feasibility.expected_shortfall_minutes == 0
        and base_plan.feasibility.expected_shortfall_minutes > 0
    ):
        warnings.append(
            "Expected workload no longer fits within available capacity."
        )

    changes: list[PlanChange] = []
    preserved_count = 0
    changed_count = 0
    for task in normalized.tasks:
        old_blocks = previous_blocks_by_task.get(task.task_id, [])
        task_new_blocks = new_blocks_by_task.get(task.task_id, [])
        task_preserved_count = sum(
            1 for block in old_blocks if block in task_new_blocks
        )
        preserved_count += task_preserved_count
        if old_blocks:
            changed_count += len(old_blocks) - task_preserved_count
        elif task_new_blocks:
            changed_count += len(task_new_blocks)

        change_type, reason = _change_type(
            old_blocks,
            task_new_blocks,
            reason_keys.get(task.task_id),
            task.expected_minutes,
        )
        changes.append(
            PlanChange(
                task_id=task.task_id,
                task_title=task.title,
                change_type=change_type,
                old_blocks=old_blocks,
                new_blocks=task_new_blocks,
                reason=reason,
            )
        )

    task_summaries = _task_summaries(normalized, new_blocks_by_task)
    candidate_plan = PlanResult(
        feasibility=base_plan.feasibility,
        scheduled_blocks=new_blocks,
        task_summaries=task_summaries,
        deadline_buffer_minutes=new_deadline_buffer,
        warnings=warnings,
        unfinished_tasks=unfinished_tasks,
    )
    _validate_previous_plan(normalized, candidate_plan)
    return ReplanResponse(
        feasibility=base_plan.feasibility.model_copy(
            update={"warnings": warnings}
        ),
        scheduled_blocks=new_blocks,
        task_summaries=task_summaries,
        deadline_buffer_minutes=new_deadline_buffer,
        changes=changes,
        preserved_block_count=preserved_count,
        changed_block_count=changed_count,
        warnings=warnings,
        unfinished_tasks=unfinished_tasks,
        previous_status=previous_status,
        new_status=new_status,
        previous_deadline_buffer_minutes=previous_buffer,
        new_deadline_buffer_minutes=new_deadline_buffer,
    )