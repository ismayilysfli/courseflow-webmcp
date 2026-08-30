import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from typing import TypeVar
from uuid import uuid4

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from models.schemas import AssignmentAnalysis

from .prompts import (
    SYSTEM_INSTRUCTION,
    build_assignment_prompt,
    build_pdf_assignment_prompt,
)

APP_NAME = "courseflow"
MODEL_NAME = "gemini-3.5-flash"
MAX_PROVIDER_ATTEMPTS = 3
TRANSIENT_PROVIDER_STATUS_CODES = {429, 500, 502, 503, 504}
T = TypeVar("T")

assignment_agent = Agent(
    name="course_assignment_agent",
    model=MODEL_NAME,
    instruction=SYSTEM_INSTRUCTION,
    output_schema=AssignmentAnalysis,
    generate_content_config=types.GenerateContentConfig(temperature=0.2),
)

def _is_transient_provider_error(error: Exception) -> bool:
    visited: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        for attribute in ("status_code", "code"):
            status = getattr(current, attribute, None)
            try:
                if int(status) in TRANSIENT_PROVIDER_STATUS_CODES:
                    return True
            except (TypeError, ValueError):
                pass
        nested = getattr(current, "error", None)
        current = (
            nested
            if isinstance(nested, BaseException)
            else current.__cause__ or current.__context__
        )
    return False


async def _run_with_provider_retries(
    operation: Callable[[], Awaitable[T]],
    *,
    delay_seconds: float = 0.25,
) -> T:
    for attempt in range(MAX_PROVIDER_ATTEMPTS):
        try:
            return await operation()
        except Exception as error:
            if (
                attempt == MAX_PROVIDER_ATTEMPTS - 1
                or not _is_transient_provider_error(error)
            ):
                raise
            await asyncio.sleep(delay_seconds * (2**attempt))
    raise RuntimeError("Provider retry loop ended unexpectedly.")


async def _run_adk_once(prompt: str) -> str:
    user_id = "courseflow-api"
    session_id = uuid4().hex
    session_service = InMemorySessionService()
    runner = Runner(
        agent=assignment_agent,
        app_name=APP_NAME,
        session_service=session_service,
    )

    await session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )

    events = runner.run_async(
        user_id=user_id,
        session_id=session_id,
        new_message=types.Content(
            role="user",
            parts=[types.Part(text=prompt)],
        ),
    )

    response_text = None
    async for event in events:
        if not event.is_final_response() or not event.content:
            continue
        response_text = next(
            (
                part.text
                for part in event.content.parts or []
                if getattr(part, "text", None)
            ),
            None,
        )

    if not response_text:
        raise RuntimeError("The ADK agent returned no final structured response.")
    return response_text


async def _run_agent_async(prompt: str) -> AssignmentAnalysis:
    response_text = await _run_with_provider_retries(
        lambda: _run_adk_once(prompt)
    )

    try:
        response_data = json.loads(response_text)
    except json.JSONDecodeError as error:
        raise RuntimeError("The ADK agent returned invalid JSON.") from error

    return AssignmentAnalysis.model_validate(response_data)


def analyze_assignment(assignment_text: str) -> AssignmentAnalysis:
    """Analyze one assignment through the Google ADK async runner."""
    return asyncio.run(
        _run_agent_async(build_assignment_prompt(assignment_text))
    )


def analyze_assignment_pages(page_blocks: str) -> AssignmentAnalysis:
    """Analyze page-marked PDF text through the same Google ADK agent."""
    return asyncio.run(_run_agent_async(build_pdf_assignment_prompt(page_blocks)))


class SourceReferenceError(ValueError):
    """Raised when the model cites a file or page outside the upload."""


def validate_source_references(
    analysis: AssignmentAnalysis,
    available_pages: dict[str, set[int]],
) -> None:
    evidence_items = list(analysis.deadline_evidence)
    evidence_items.extend(
        evidence
        for sourced_fact in analysis.deliverable_evidence
        for evidence in sourced_fact.evidence
    )
    evidence_items.extend(
        evidence
        for sourced_fact in analysis.requirement_evidence
        for evidence in sourced_fact.evidence
    )
    evidence_items.extend(
        evidence for task in analysis.tasks for evidence in task.evidence
    )

    for evidence in evidence_items:
        if evidence.source_file not in available_pages:
            raise SourceReferenceError(
                f"Gemini cited an uploaded file that was not supplied: "
                f"{evidence.source_file}"
            )
        if evidence.page_number is None:
            raise SourceReferenceError(
                f"Gemini did not provide a page number for {evidence.source_file}."
            )
        if evidence.page_number not in available_pages[evidence.source_file]:
            raise SourceReferenceError(
                f"Gemini cited page {evidence.page_number} of "
                f"{evidence.source_file}, but that page does not exist."
            )

    if analysis.deadline is not None and not analysis.deadline_evidence:
        raise SourceReferenceError(
            "The extracted deadline did not include source evidence."
        )
    deliverable_evidence = {
        sourced_fact.fact: sourced_fact.evidence
        for sourced_fact in analysis.deliverable_evidence
    }
    for deliverable in analysis.deliverables:
        if not deliverable_evidence.get(deliverable):
            raise SourceReferenceError(
                f"The deliverable {deliverable!r} did not include source evidence."
            )
    requirement_evidence = {
        sourced_fact.fact: sourced_fact.evidence
        for sourced_fact in analysis.requirement_evidence
    }
    for requirement in analysis.requirements:
        if not requirement_evidence.get(requirement):
            raise SourceReferenceError(
                f"The requirement {requirement!r} did not include source evidence."
            )
    for task in analysis.tasks:
        if task.source_requirement and not task.evidence:
            raise SourceReferenceError(
                f"The task {task.title!r} did not include source evidence."
            )