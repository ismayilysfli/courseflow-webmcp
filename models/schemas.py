from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


Confidence = Literal["low", "medium", "high"]


class SourceEvidence(BaseModel):
    source_file: str = Field(min_length=1)
    page_number: int | None = Field(default=None, ge=1)
    source_snippet: str = Field(min_length=1, max_length=500)


class EvidenceBackedFact(BaseModel):
    fact: str = Field(min_length=1)
    is_optional: bool | None = None
    evidence: list[SourceEvidence] = Field(default_factory=list)


class TaskEstimate(BaseModel):
    task_id: str | None = None
    title: str = Field(min_length=1)
    description: str = Field(min_length=1)
    source_requirement: str = Field(min_length=1)
    dependencies: list[str] = Field(default_factory=list)
    optimistic_minutes: int = Field(ge=0)
    expected_minutes: int = Field(ge=0)
    pessimistic_minutes: int = Field(ge=0)
    confidence: Confidence
    estimation_reason: str = Field(min_length=1)
    is_optional: bool = False
    evidence: list[SourceEvidence] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_estimate_order(self) -> "TaskEstimate":
        if not (
            self.optimistic_minutes
            <= self.expected_minutes
            <= self.pessimistic_minutes
        ):
            raise ValueError(
                "optimistic_minutes must be less than or equal to "
                "expected_minutes, which must be less than or equal to "
                "pessimistic_minutes"
            )
        return self


class AssignmentAnalysis(BaseModel):
    title: str = Field(min_length=1)
    deadline: str | None = None
    deadline_iso: str | None = None
    deadline_evidence: list[SourceEvidence] = Field(default_factory=list)
    deliverables: list[str] = Field(default_factory=list)
    deliverable_evidence: list[EvidenceBackedFact] = Field(default_factory=list)
    requirements: list[str] = Field(default_factory=list)
    requirement_evidence: list[EvidenceBackedFact] = Field(default_factory=list)
    ambiguities: list[str] = Field(default_factory=list)
    tasks: list[TaskEstimate] = Field(default_factory=list)

    @field_validator("deadline_iso")
    @classmethod
    def validate_deadline_iso(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("deadline_iso must be a valid ISO-8601 datetime") from error
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("deadline_iso must include a timezone")
        return value

    @model_validator(mode="after")
    def assign_deterministic_task_ids(self) -> "AssignmentAnalysis":
        self.tasks = [
            task.model_copy(update={"task_id": f"task-{index}"})
            for index, task in enumerate(self.tasks, start=1)
        ]
        return self


class AvailabilityWindow(BaseModel):
    start: datetime
    end: datetime

    @field_validator("start", "end")
    @classmethod
    def validate_timezone_aware(
        cls, value: datetime
    ) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("availability datetimes must include a timezone")
        return value

    @model_validator(mode="after")
    def validate_window_order(self) -> "AvailabilityWindow":
        if self.end <= self.start:
            raise ValueError("availability end must be after start")
        return self


class PlanRequest(BaseModel):
    analysis: AssignmentAnalysis
    availability: list[AvailabilityWindow] = Field(default_factory=list)


class ScheduledBlock(BaseModel):
    task_id: str = Field(min_length=1)
    task_title: str = Field(min_length=1)
    start: datetime
    end: datetime
    scheduled_minutes: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_block(self) -> "ScheduledBlock":
        if self.start.tzinfo is None or self.start.utcoffset() is None:
            raise ValueError("scheduled block start must include a timezone")
        if self.end.tzinfo is None or self.end.utcoffset() is None:
            raise ValueError("scheduled block end must include a timezone")
        if self.end <= self.start:
            raise ValueError("scheduled block end must be after start")
        if int((self.end - self.start).total_seconds() // 60) != self.scheduled_minutes:
            raise ValueError("scheduled_minutes must match the block duration")
        return self


class TaskScheduleSummary(BaseModel):
    task_id: str = Field(min_length=1)
    total_required_minutes: int = Field(ge=0)
    total_scheduled_minutes: int = Field(ge=0)
    completed_in_plan: bool


FeasibilityStatus = Literal["comfortable", "tight", "at_risk", "infeasible"]


class FeasibilitySummary(BaseModel):
    available_minutes: int = Field(ge=0)
    optimistic_workload_minutes: int = Field(ge=0)
    expected_workload_minutes: int = Field(ge=0)
    pessimistic_workload_minutes: int = Field(ge=0)
    expected_shortfall_minutes: int = Field(ge=0)
    optimistic_shortfall_minutes: int = Field(ge=0)
    status: FeasibilityStatus
    warnings: list[str] = Field(default_factory=list)


class PlanResult(BaseModel):
    feasibility: FeasibilitySummary
    scheduled_blocks: list[ScheduledBlock] = Field(default_factory=list)
    task_summaries: list[TaskScheduleSummary] = Field(default_factory=list)
    deadline_buffer_minutes: int | None = None
    warnings: list[str] = Field(default_factory=list)
    unfinished_tasks: list[str] = Field(default_factory=list)


ReplanChangeType = Literal[
    "preserved",
    "moved",
    "rescheduled",
    "split",
    "unscheduled",
    "partially_rescheduled",
]


class ReplanRequest(BaseModel):
    analysis: AssignmentAnalysis
    previous_plan: PlanResult
    new_availability: list[AvailabilityWindow] = Field(default_factory=list)


class PlanChange(BaseModel):
    task_id: str = Field(min_length=1)
    task_title: str = Field(min_length=1)
    change_type: ReplanChangeType
    old_blocks: list[ScheduledBlock] = Field(default_factory=list)
    new_blocks: list[ScheduledBlock] = Field(default_factory=list)
    reason: str = Field(min_length=1)


class ReplanResponse(BaseModel):
    feasibility: FeasibilitySummary
    scheduled_blocks: list[ScheduledBlock] = Field(default_factory=list)
    task_summaries: list[TaskScheduleSummary] = Field(default_factory=list)
    deadline_buffer_minutes: int | None = None
    changes: list[PlanChange] = Field(default_factory=list)
    preserved_block_count: int = Field(ge=0)
    changed_block_count: int = Field(ge=0)
    warnings: list[str] = Field(default_factory=list)
    unfinished_tasks: list[str] = Field(default_factory=list)
    previous_status: FeasibilityStatus
    new_status: FeasibilityStatus
    previous_deadline_buffer_minutes: int | None = None
    new_deadline_buffer_minutes: int | None = None