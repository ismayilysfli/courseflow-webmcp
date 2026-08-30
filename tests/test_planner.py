import unittest
from datetime import datetime, timedelta, timezone

from app import app
from models.schemas import AssignmentAnalysis, AvailabilityWindow, TaskEstimate
from services.planner import PlannerError, build_plan, normalize_analysis


BASE_TIME = datetime(2026, 8, 28, 10, 0, tzinfo=timezone.utc)


def make_task(
    title: str = "Task A",
    *,
    optimistic: int = 60,
    expected: int = 120,
    pessimistic: int = 180,
    dependencies: list[str] | None = None,
) -> TaskEstimate:
    return TaskEstimate(
        title=title,
        description=f"Complete {title}",
        source_requirement=f"Requirement for {title}",
        dependencies=dependencies or [],
        optimistic_minutes=optimistic,
        expected_minutes=expected,
        pessimistic_minutes=pessimistic,
        confidence="medium",
        estimation_reason="Deterministic planner test estimate",
    )


def make_analysis(
    tasks: list[TaskEstimate],
    deadline_iso: str | None = None,
) -> AssignmentAnalysis:
    return AssignmentAnalysis(
        title="Planner test",
        deadline="Test deadline" if deadline_iso else None,
        deadline_iso=deadline_iso,
        tasks=tasks,
    )


def window(minutes: int, start: datetime = BASE_TIME) -> AvailabilityWindow:
    return AvailabilityWindow(
        start=start,
        end=start + timedelta(minutes=minutes),
    )


class PlannerTests(unittest.TestCase):
    def test_comfortable_status(self):
        result = build_plan(make_analysis([make_task()]), [window(180)])
        self.assertEqual(result.feasibility.status, "comfortable")

    def test_tight_status(self):
        result = build_plan(make_analysis([make_task()]), [window(150)])
        self.assertEqual(result.feasibility.status, "tight")

    def test_at_risk_status(self):
        result = build_plan(make_analysis([make_task()]), [window(100)])
        self.assertEqual(result.feasibility.status, "at_risk")
        self.assertEqual(result.feasibility.expected_shortfall_minutes, 20)

    def test_infeasible_status(self):
        result = build_plan(make_analysis([make_task()]), [window(50)])
        self.assertEqual(result.feasibility.status, "infeasible")
        self.assertEqual(result.feasibility.optimistic_shortfall_minutes, 10)

    def test_dependency_order_uses_resolved_ids(self):
        analysis = make_analysis(
            [
                make_task(
                    "Task B",
                    optimistic=15,
                    expected=30,
                    pessimistic=60,
                    dependencies=["Task A"],
                ),
                make_task(
                    "Task A",
                    optimistic=15,
                    expected=30,
                    pessimistic=60,
                ),
            ]
        )
        result = build_plan(analysis, [window(60)])
        self.assertEqual(
            [block.task_title for block in result.scheduled_blocks],
            ["Task A", "Task B"],
        )
        self.assertEqual(result.scheduled_blocks[0].task_id, "task-2")
        self.assertEqual(result.scheduled_blocks[1].task_id, "task-1")
        self.assertLessEqual(
            result.scheduled_blocks[0].end,
            result.scheduled_blocks[1].start,
        )

    def test_task_splits_across_windows(self):
        analysis = make_analysis(
            [make_task(expected=180, pessimistic=180)]
        )
        result = build_plan(
            analysis,
            [
                window(60),
                window(120, BASE_TIME + timedelta(days=1)),
            ],
        )
        self.assertEqual(
            [block.scheduled_minutes for block in result.scheduled_blocks],
            [60, 120],
        )
        self.assertTrue(result.task_summaries[0].completed_in_plan)

    def test_deadline_clips_schedule(self):
        deadline = BASE_TIME + timedelta(minutes=90)
        analysis = make_analysis(
            [make_task(expected=120)],
            deadline.isoformat(),
        )
        result = build_plan(analysis, [window(180)])
        self.assertEqual(result.feasibility.available_minutes, 90)
        self.assertEqual(result.scheduled_blocks[-1].end, deadline)
        self.assertFalse(result.task_summaries[0].completed_in_plan)
        self.assertEqual(result.deadline_buffer_minutes, 0)

    def test_cycle_is_rejected(self):
        analysis = make_analysis(
            [
                make_task("Task A", dependencies=["Task B"]),
                make_task("Task B", dependencies=["Task A"]),
            ]
        )
        with self.assertRaisesRegex(PlannerError, "cycle"):
            normalize_analysis(analysis)

    def test_unknown_dependency_is_rejected(self):
        analysis = make_analysis(
            [make_task("Task A", dependencies=["Missing Task"])]
        )
        with self.assertRaisesRegex(PlannerError, "unknown dependency"):
            normalize_analysis(analysis)

    def test_self_dependency_is_rejected(self):
        analysis = make_analysis(
            [make_task("Task A", dependencies=["Task A"])]
        )
        with self.assertRaisesRegex(PlannerError, "itself"):
            normalize_analysis(analysis)

    def test_task_ids_are_reassigned_deterministically(self):
        analysis = make_analysis(
            [
                make_task("Task A").model_copy(update={"task_id": "invented"}),
                make_task("Task B"),
            ]
        )
        normalized = normalize_analysis(analysis)
        self.assertEqual(
            [task.task_id for task in normalized.tasks],
            ["task-1", "task-2"],
        )

    def test_validated_analysis_always_has_deterministic_task_ids(self):
        analysis = make_analysis([make_task("Task A"), make_task("Task B")])
        self.assertEqual(
            [task.task_id for task in analysis.tasks],
            ["task-1", "task-2"],
        )

    def test_dependency_title_takes_precedence_over_id_collision(self):
        analysis = make_analysis(
            [
                make_task(
                    "task-2",
                    optimistic=15,
                    expected=30,
                    pessimistic=60,
                ),
                make_task(
                    "Task B",
                    optimistic=15,
                    expected=30,
                    pessimistic=60,
                    dependencies=["task-2"],
                ),
            ]
        )
        result = build_plan(analysis, [window(60)])
        self.assertEqual(
            [block.task_title for block in result.scheduled_blocks],
            ["task-2", "Task B"],
        )

    def test_plan_endpoint(self):
        analysis = make_analysis([make_task()])
        response = app.test_client().post(
            "/api/plan",
            json={
                "analysis": analysis.model_dump(mode="json"),
                "availability": [
                    window(180).model_dump(mode="json")
                ],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["feasibility"]["status"], "comfortable")

    def test_optional_tasks_excluded_from_feasibility_and_scheduled_correctly(self):
        analysis = make_analysis([
            make_task("Train Model", optimistic=180, expected=300, pessimistic=400, is_optional=False),
            make_task("Implement Optional Bonus", optimistic=30, expected=60, pessimistic=90, is_optional=True, dependencies=["Train Model"]),
            make_task("Write Report and README", optimistic=100, expected=180, pessimistic=240, is_optional=False, dependencies=["Train Model"]),
            make_task("Package and Verify Submission", optimistic=30, expected=75, pessimistic=100, is_optional=False, dependencies=["Write Report and README"]),
        ])
        result = build_plan(analysis, [window(480)])
        self.assertEqual(result.feasibility.status, "at_risk")
        self.assertEqual(result.feasibility.expected_workload_minutes, 555)
        self.assertEqual(result.feasibility.available_minutes, 480)
        self.assertEqual(len(result.scheduled_blocks), 2)
        self.assertEqual(result.scheduled_blocks[0].task_title, "Train Model")
        self.assertEqual(result.scheduled_blocks[0].scheduled_minutes, 300)
        self.assertEqual(result.scheduled_blocks[1].task_title, "Write Report and README")
        self.assertEqual(result.scheduled_blocks[1].scheduled_minutes, 180)
        
        bonus_summary = next(s for s in result.task_summaries if s.task_id == "task-2")
        self.assertEqual(bonus_summary.total_scheduled_minutes, 0)
        self.assertFalse(bonus_summary.completed_in_plan)
        
        self.assertIn("task-4", result.unfinished_tasks)
        self.assertIn("task-2", result.unfinished_tasks)


if __name__ == "__main__":
    unittest.main()