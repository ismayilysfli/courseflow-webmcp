import unittest
from datetime import timedelta

from app import app
from models.schemas import ScheduledBlock
from services.planner import PlannerError, build_plan
from services.replanner import replan
from tests.test_planner import BASE_TIME, make_analysis, make_task, window


class ReplannerTests(unittest.TestCase):
    def test_unchanged_availability_preserves_every_block(self):
        analysis = make_analysis([make_task(expected=120, pessimistic=120)])
        availability = [window(60), window(60, BASE_TIME + timedelta(days=1))]
        previous = build_plan(analysis, availability)

        result = replan(analysis, previous, availability)

        self.assertEqual(result.scheduled_blocks, previous.scheduled_blocks)
        self.assertEqual(
            result.preserved_block_count,
            len(previous.scheduled_blocks),
        )
        self.assertEqual(result.changed_block_count, 0)
        self.assertTrue(
            all(change.change_type == "preserved" for change in result.changes)
        )

    def test_removed_day_moves_only_affected_work(self):
        analysis = make_analysis([make_task(expected=120, pessimistic=120)])
        day_one = window(60)
        day_two = window(60, BASE_TIME + timedelta(days=1))
        day_three = window(60, BASE_TIME + timedelta(days=2))
        previous = build_plan(analysis, [day_one, day_two])

        result = replan(analysis, previous, [day_two, day_three])

        self.assertIn(previous.scheduled_blocks[1], result.scheduled_blocks)
        self.assertNotIn(previous.scheduled_blocks[0], result.scheduled_blocks)
        self.assertEqual(result.preserved_block_count, 1)
        self.assertTrue(result.task_summaries[0].completed_in_plan)

    def test_remaining_work_can_use_capacity_before_later_preserved_block(self):
        analysis = make_analysis([make_task(expected=120, pessimistic=120)])
        old_day = window(60)
        preserved_day = window(60, BASE_TIME + timedelta(days=2))
        previous = build_plan(analysis, [old_day, preserved_day])
        earlier_replacement = window(60, BASE_TIME + timedelta(days=1))

        result = replan(
            analysis,
            previous,
            [earlier_replacement, preserved_day],
        )

        self.assertEqual(result.preserved_block_count, 1)
        self.assertTrue(result.task_summaries[0].completed_in_plan)
        self.assertEqual(
            [block.start for block in result.scheduled_blocks],
            [earlier_replacement.start, preserved_day.start],
        )

    def test_shortened_window_reschedules_and_splits_work(self):
        analysis = make_analysis([make_task(expected=120, pessimistic=120)])
        previous = build_plan(analysis, [window(120)])

        result = replan(
            analysis,
            previous,
            [window(60), window(60, BASE_TIME + timedelta(days=1))],
        )

        self.assertEqual(result.preserved_block_count, 0)
        self.assertEqual(
            [block.scheduled_minutes for block in result.scheduled_blocks],
            [60, 60],
        )
        self.assertEqual(result.changes[0].change_type, "split")

    def test_dependency_change_propagates_to_dependent_block(self):
        analysis = make_analysis(
            [
                make_task(
                    "Task A",
                    optimistic=30,
                    expected=60,
                    pessimistic=60,
                ),
                make_task(
                    "Task B",
                    optimistic=30,
                    expected=60,
                    pessimistic=60,
                    dependencies=["Task A"],
                ),
            ]
        )
        previous = build_plan(analysis, [window(120)])
        new_availability = [
            window(60, BASE_TIME + timedelta(hours=1)),
            window(60, BASE_TIME + timedelta(days=1)),
        ]

        result = replan(analysis, previous, new_availability)

        task_b_change = next(
            change for change in result.changes if change.task_title == "Task B"
        )
        self.assertEqual(task_b_change.change_type, "rescheduled")
        self.assertIn("prerequisite", task_b_change.reason.lower())
        task_a_end = max(
            block.end
            for block in result.scheduled_blocks
            if block.task_title == "Task A"
        )
        task_b_start = min(
            block.start
            for block in result.scheduled_blocks
            if block.task_title == "Task B"
        )
        self.assertLessEqual(task_a_end, task_b_start)

    def test_status_can_change_from_comfortable_to_tight(self):
        analysis = make_analysis([make_task()])
        previous = build_plan(analysis, [window(180)])
        result = replan(analysis, previous, [window(150)])
        self.assertEqual(result.previous_status, "comfortable")
        self.assertEqual(result.new_status, "tight")

    def test_status_can_change_to_at_risk(self):
        analysis = make_analysis([make_task()])
        previous = build_plan(analysis, [window(180)])
        result = replan(analysis, previous, [window(100)])
        self.assertEqual(result.new_status, "at_risk")

    def test_status_can_change_to_infeasible(self):
        analysis = make_analysis([make_task()])
        previous = build_plan(analysis, [window(180)])
        result = replan(analysis, previous, [window(50)])
        self.assertEqual(result.new_status, "infeasible")

    def test_deadline_buffer_decreases(self):
        deadline = BASE_TIME + timedelta(days=3)
        analysis = make_analysis(
            [make_task(expected=60, pessimistic=60)],
            deadline.isoformat(),
        )
        previous = build_plan(analysis, [window(60)])
        result = replan(
            analysis,
            previous,
            [window(60, BASE_TIME + timedelta(days=1))],
        )
        self.assertEqual(
            result.previous_deadline_buffer_minutes
            - result.new_deadline_buffer_minutes,
            1440,
        )
        self.assertTrue(
            any("buffer decreased" in warning.lower() for warning in result.warnings)
        )

    def test_insufficient_capacity_leaves_work_unfinished(self):
        analysis = make_analysis([make_task()])
        previous = build_plan(analysis, [window(180)])
        result = replan(analysis, previous, [window(50)])
        self.assertEqual(result.unfinished_tasks, ["task-1"])
        self.assertFalse(result.task_summaries[0].completed_in_plan)
        self.assertEqual(result.task_summaries[0].total_scheduled_minutes, 50)

    def test_repaired_plan_has_no_overlapping_or_duplicate_blocks(self):
        analysis = make_analysis(
            [
                make_task(
                    "Task A",
                    optimistic=30,
                    expected=90,
                    pessimistic=120,
                ),
                make_task(
                    "Task B",
                    optimistic=30,
                    expected=90,
                    pessimistic=120,
                ),
            ]
        )
        previous = build_plan(analysis, [window(180)])
        result = replan(
            analysis,
            previous,
            [window(60), window(120, BASE_TIME + timedelta(days=1))],
        )
        blocks = sorted(result.scheduled_blocks, key=lambda block: block.start)
        self.assertEqual(len(blocks), len(set(
            (block.task_id, block.start, block.end) for block in blocks
        )))
        self.assertTrue(
            all(current.start >= previous.end for previous, current in zip(blocks, blocks[1:]))
        )

    def test_replan_endpoint(self):
        analysis = make_analysis([make_task(expected=120, pessimistic=120)])
        availability = [window(120)]
        previous = build_plan(analysis, availability)
        response = app.test_client().post(
            "/api/replan",
            json={
                "analysis": analysis.model_dump(mode="json"),
                "previous_plan": previous.model_dump(mode="json"),
                "new_availability": [
                    item.model_dump(mode="json") for item in availability
                ],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["preserved_block_count"], 1)

    def test_previous_plan_after_deadline_is_rejected(self):
        deadline = BASE_TIME + timedelta(minutes=60)
        analysis = make_analysis(
            [make_task(expected=60, pessimistic=60)],
            deadline.isoformat(),
        )
        previous = build_plan(analysis, [window(60)])
        late_block = ScheduledBlock(
            task_id="task-1",
            task_title="Task A",
            start=deadline,
            end=deadline + timedelta(minutes=60),
            scheduled_minutes=60,
        )
        invalid = previous.model_copy(
            update={
                "scheduled_blocks": [late_block],
                "deadline_buffer_minutes": -60,
            }
        )
        with self.assertRaisesRegex(PlannerError, "after the deadline"):
            replan(analysis, invalid, [window(120)])

    def test_inconsistent_previous_feasibility_is_rejected(self):
        analysis = make_analysis([make_task()])
        previous = build_plan(analysis, [window(180)])
        forged = previous.model_copy(
            update={
                "feasibility": previous.feasibility.model_copy(
                    update={"status": "infeasible"}
                )
            }
        )
        with self.assertRaisesRegex(PlannerError, "feasibility metadata"):
            replan(analysis, forged, [window(180)])


if __name__ == "__main__":
    unittest.main()