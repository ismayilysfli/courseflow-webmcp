import assert from 'assert';
import {
  AssignmentAnalysis,
  AvailabilityWindow,
  PlanResult,
  TaskEstimate,
} from '../types.js';
import {
  PlannerError,
  buildPlan,
  normalizeAnalysis,
} from '../services/planner.js';
import { replan } from '../services/replanner.js';
import {
  buildPlanCreatedEvent,
  buildPlanReplannedEvent,
} from '../services/firestoreService.js';

const BASE_TIME = new Date('2026-08-28T10:00:00.000Z');

function makeTask(
  title: string = 'Task A',
  opts: {
    optimistic?: number;
    expected?: number;
    pessimistic?: number;
    dependencies?: string[];
    is_optional?: boolean;
  } = {}
): TaskEstimate {
  const {
    optimistic = 60,
    expected = 120,
    pessimistic = 180,
    dependencies = [],
    is_optional = false,
  } = opts;
  return {
    title,
    description: `Complete ${title}`,
    source_requirement: `Requirement for ${title}`,
    dependencies,
    optimistic_minutes: optimistic,
    expected_minutes: expected,
    pessimistic_minutes: pessimistic,
    confidence: 'medium',
    estimation_reason: 'Deterministic planner test estimate',
    is_optional,
    evidence: [],
  };
}

function makeAnalysis(
  tasks: TaskEstimate[],
  deadline_iso: string | null = null
): AssignmentAnalysis {
  return {
    title: 'Planner test',
    deadline: deadline_iso ? 'Test deadline' : null,
    deadline_iso,
    deliverables: [],
    deliverable_evidence: [],
    requirements: [],
    requirement_evidence: [],
    ambiguities: [],
    tasks,
  };
}

function window(minutes: number, start: Date = BASE_TIME): AvailabilityWindow {
  const end = new Date(start.getTime() + minutes * 60000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

console.log('Running Planner Tests...');

// 1. comfortable status
{
  const result = buildPlan(makeAnalysis([makeTask()]), [window(180)]);
  assert.strictEqual(result.feasibility.status, 'comfortable');
}

// 2. tight status
{
  const result = buildPlan(makeAnalysis([makeTask()]), [window(150)]);
  assert.strictEqual(result.feasibility.status, 'tight');
}

// 3. at risk status
{
  const result = buildPlan(makeAnalysis([makeTask()]), [window(100)]);
  assert.strictEqual(result.feasibility.status, 'at_risk');
  assert.strictEqual(result.feasibility.expected_shortfall_minutes, 20);
}

// 4. infeasible status
{
  const result = buildPlan(makeAnalysis([makeTask()]), [window(50)]);
  assert.strictEqual(result.feasibility.status, 'infeasible');
  assert.strictEqual(result.feasibility.optimistic_shortfall_minutes, 10);
}

// 5. dependency order
{
  const analysis = makeAnalysis([
    makeTask('Task B', {
      optimistic: 15,
      expected: 30,
      pessimistic: 60,
      dependencies: ['Task A'],
    }),
    makeTask('Task A', {
      optimistic: 15,
      expected: 30,
      pessimistic: 60,
    }),
  ]);
  const result = buildPlan(analysis, [window(60)]);
  assert.deepStrictEqual(
    result.scheduled_blocks.map((b) => b.task_title),
    ['Task A', 'Task B']
  );
  assert.strictEqual(result.scheduled_blocks[0].task_id, 'task-2');
  assert.strictEqual(result.scheduled_blocks[1].task_id, 'task-1');
  assert(
    new Date(result.scheduled_blocks[0].end).getTime() <=
      new Date(result.scheduled_blocks[1].start).getTime()
  );
}

// 6. task splits across windows
{
  const analysis = makeAnalysis([makeTask('Task A', { expected: 180, pessimistic: 180 })]);
  const nextDay = new Date(BASE_TIME.getTime() + 24 * 3600 * 1000);
  const result = buildPlan(analysis, [window(60), window(120, nextDay)]);
  assert.deepStrictEqual(
    result.scheduled_blocks.map((b) => b.scheduled_minutes),
    [60, 120]
  );
  assert.strictEqual(result.task_summaries[0].completed_in_plan, true);
}

// 7. deadline clips schedule
{
  const deadline = new Date(BASE_TIME.getTime() + 90 * 60000);
  const analysis = makeAnalysis(
    [makeTask('Task A', { expected: 120 })],
    deadline.toISOString()
  );
  const result = buildPlan(analysis, [window(180)]);
  assert.strictEqual(result.feasibility.available_minutes, 90);
  assert.strictEqual(
    new Date(result.scheduled_blocks[result.scheduled_blocks.length - 1].end).getTime(),
    deadline.getTime()
  );
  assert.strictEqual(result.task_summaries[0].completed_in_plan, false);
  assert.strictEqual(result.deadline_buffer_minutes, 0);
}

// 8. cycle is rejected
{
  const analysis = makeAnalysis([
    makeTask('Task A', { dependencies: ['Task B'] }),
    makeTask('Task B', { dependencies: ['Task A'] }),
  ]);
  assert.throws(() => normalizeAnalysis(analysis), /cycle/);
}

// 9. unknown dependency is rejected
{
  const analysis = makeAnalysis([
    makeTask('Task A', { dependencies: ['Missing Task'] }),
  ]);
  assert.throws(() => normalizeAnalysis(analysis), /unknown dependency/);
}

// 10. self dependency is rejected
{
  const analysis = makeAnalysis([
    makeTask('Task A', { dependencies: ['Task A'] }),
  ]);
  assert.throws(() => normalizeAnalysis(analysis), /itself/);
}

// 11. optional tasks are excluded from feasibility calculations
{
  const analysis = makeAnalysis([
    makeTask('Mandatory Task', { optimistic: 60, expected: 120, pessimistic: 180, is_optional: false }),
    makeTask('Bonus Task', { optimistic: 30, expected: 60, pessimistic: 90, is_optional: true }),
  ]);
  // Available: 180 mins. Mandatory is 120 exp, 180 pess -> comfortable for mandatory!
  // If optional was included, total expected would be 180, total pess 270 (tight or at_risk).
  const result = buildPlan(analysis, [window(180)]);
  assert.strictEqual(result.feasibility.status, 'comfortable');
  assert.strictEqual(result.feasibility.expected_workload_minutes, 120);
  assert.strictEqual(result.feasibility.optimistic_workload_minutes, 60);
  assert.strictEqual(result.feasibility.pessimistic_workload_minutes, 180);
  assert.strictEqual(result.feasibility.expected_shortfall_minutes, 0);

  // Both mandatory (120m) and optional (60m) are scheduled because capacity (180m) fits both
  assert.strictEqual(result.scheduled_blocks.length, 2);
  assert.strictEqual(result.scheduled_blocks[0].task_title, 'Mandatory Task');
  assert.strictEqual(result.scheduled_blocks[1].task_title, 'Bonus Task');
}

// 12. optional task scheduled only if capacity remains after required work
{
  const analysis = makeAnalysis([
    makeTask('Bonus Task', { optimistic: 30, expected: 60, pessimistic: 90, is_optional: true }),
    makeTask('Mandatory Task', { optimistic: 60, expected: 120, pessimistic: 180, is_optional: false }),
  ]);
  // Available: 150 mins.
  // Mandatory task needs 120 mins -> gets 120 mins.
  // Remaining capacity is 30 mins -> Bonus task gets scheduled for 30 mins.
  const result = buildPlan(analysis, [window(150)]);
  assert.strictEqual(result.feasibility.status, 'tight');
  assert.strictEqual(result.scheduled_blocks[0].task_title, 'Mandatory Task');
  assert.strictEqual(result.scheduled_blocks[0].scheduled_minutes, 120);
  assert.strictEqual(result.scheduled_blocks[1].task_title, 'Bonus Task');
  assert.strictEqual(result.scheduled_blocks[1].scheduled_minutes, 30);
}

// 13. optional task not scheduled when mandatory uses all capacity
{
  const analysis = makeAnalysis([
    makeTask('Bonus Task', { optimistic: 30, expected: 60, pessimistic: 90, is_optional: true }),
    makeTask('Mandatory Task', { optimistic: 60, expected: 120, pessimistic: 180, is_optional: false }),
  ]);
  // Available: 120 mins. Mandatory uses all 120 mins.
  const result = buildPlan(analysis, [window(120)]);
  assert.strictEqual(result.feasibility.status, 'tight');
  assert.strictEqual(result.scheduled_blocks.length, 1);
  assert.strictEqual(result.scheduled_blocks[0].task_title, 'Mandatory Task');
}

// 14. 8h capacity, 9h15 mandatory workload, 1h optional task: optional receives 0 mins, mandatory consumes 8h
{
  const analysis = makeAnalysis([
    makeTask('Train Model', {
      optimistic: 180,
      expected: 300,
      pessimistic: 400,
      is_optional: false,
    }),
    makeTask('Implement Optional Bonus', {
      optimistic: 30,
      expected: 60,
      pessimistic: 90,
      is_optional: true,
      dependencies: ['Train Model'],
    }),
    makeTask('Write Report and README', {
      optimistic: 100,
      expected: 180,
      pessimistic: 240,
      is_optional: false,
      dependencies: ['Train Model'],
    }),
    makeTask('Package and Verify Submission', {
      optimistic: 30,
      expected: 75,
      pessimistic: 100,
      is_optional: false,
      dependencies: ['Write Report and README'],
    }),
  ]);

  // 8h capacity = 480 mins
  const result = buildPlan(analysis, [window(480)]);

  // Feasibility status remains At Risk (optimistic 310 <= 480 < expected 555)
  assert.strictEqual(result.feasibility.status, 'at_risk');
  assert.strictEqual(result.feasibility.expected_workload_minutes, 555); // 300 + 180 + 75 = 555 (9h15)
  assert.strictEqual(result.feasibility.optimistic_workload_minutes, 310);
  assert.strictEqual(result.feasibility.pessimistic_workload_minutes, 740);
  assert.strictEqual(result.feasibility.available_minutes, 480);
  assert.strictEqual(result.feasibility.expected_shortfall_minutes, 75);

  // Mandatory tasks consume all 8 hours (480 mins) according to dependency order
  assert.strictEqual(result.scheduled_blocks.length, 2);
  assert.strictEqual(result.scheduled_blocks[0].task_title, 'Train Model');
  assert.strictEqual(result.scheduled_blocks[0].scheduled_minutes, 300);
  assert.strictEqual(result.scheduled_blocks[1].task_title, 'Write Report and README');
  assert.strictEqual(result.scheduled_blocks[1].scheduled_minutes, 180);

  const totalScheduledMinutes = result.scheduled_blocks.reduce((s, b) => s + b.scheduled_minutes, 0);
  assert.strictEqual(totalScheduledMinutes, 480); // exactly 8 hours

  // Optional task receives exactly 0 minutes
  const bonusSummary = result.task_summaries.find((s) => s.task_id === 'task-2')!;
  assert.strictEqual(bonusSummary.total_scheduled_minutes, 0);
  assert.strictEqual(bonusSummary.completed_in_plan, false);

  // Unfinished mandatory work (Package and Verify Submission) is reported correctly
  const packageSummary = result.task_summaries.find((s) => s.task_id === 'task-4')!;
  assert.strictEqual(packageSummary.total_scheduled_minutes, 0);
  assert.strictEqual(packageSummary.completed_in_plan, false);

  assert(result.unfinished_tasks.includes('task-4')); // unfinished mandatory task
  assert(result.unfinished_tasks.includes('task-2')); // unfinished optional task
}

console.log('Running Replanner Tests...');

// 14. unchanged availability preserves every block
{
  const analysis = makeAnalysis([makeTask('Task A', { expected: 120, pessimistic: 120 })]);
  const nextDay = new Date(BASE_TIME.getTime() + 24 * 3600 * 1000);
  const availability = [window(60), window(60, nextDay)];
  const previous = buildPlan(analysis, availability);

  const result = replan(analysis, previous, availability);
  assert.strictEqual(result.preserved_block_count, previous.scheduled_blocks.length);
  assert.strictEqual(result.changed_block_count, 0);
  assert(result.changes.every((c) => c.change_type === 'preserved'));
}

// 15. removed day moves only affected work
{
  const analysis = makeAnalysis([makeTask('Task A', { expected: 120, pessimistic: 120 })]);
  const dayOne = window(60);
  const dayTwo = window(60, new Date(BASE_TIME.getTime() + 24 * 3600 * 1000));
  const dayThree = window(60, new Date(BASE_TIME.getTime() + 48 * 3600 * 1000));
  const previous = buildPlan(analysis, [dayOne, dayTwo]);

  const result = replan(analysis, previous, [dayTwo, dayThree]);
  assert.strictEqual(result.preserved_block_count, 1);
  assert.strictEqual(result.task_summaries[0].completed_in_plan, true);
}

// 16. shortened window reschedules and splits work
{
  const analysis = makeAnalysis([makeTask('Task A', { expected: 120, pessimistic: 120 })]);
  const previous = buildPlan(analysis, [window(120)]);
  const nextDay = new Date(BASE_TIME.getTime() + 24 * 3600 * 1000);

  const result = replan(analysis, previous, [window(60), window(60, nextDay)]);
  assert.strictEqual(result.preserved_block_count, 0);
  assert.deepStrictEqual(
    result.scheduled_blocks.map((b) => b.scheduled_minutes),
    [60, 60]
  );
  assert.strictEqual(result.changes[0].change_type, 'split');
}

// 17. replanning with optional tasks
{
  const analysis = makeAnalysis([
    makeTask('Mandatory Task', { expected: 120, is_optional: false }),
    makeTask('Optional Task', { expected: 60, is_optional: true }),
  ]);
  const previous = buildPlan(analysis, [window(180)]);
  const nextDay = new Date(BASE_TIME.getTime() + 24 * 3600 * 1000);
  const result = replan(analysis, previous, [window(120), window(60, nextDay)]);
  assert.strictEqual(result.task_summaries[0].completed_in_plan, true);
  assert.strictEqual(result.task_summaries[1].completed_in_plan, true);
}

// 18. partial rescheduling labeling, impact count consistency, and infeasible deadline buffer
{
  const deadline = new Date(BASE_TIME.getTime() + 7 * 24 * 3600 * 1000);
  const analysis = makeAnalysis(
    [
      makeTask('Data preparation', { expected: 60, optimistic: 30, pessimistic: 90 }),
      makeTask('Train/validation split', { expected: 60, optimistic: 30, pessimistic: 90, dependencies: ['Data preparation'] }),
      makeTask('Baseline', { expected: 60, optimistic: 30, pessimistic: 90, dependencies: ['Train/validation split'] }),
      makeTask('Comparison model', { expected: 90, optimistic: 45, pessimistic: 120, dependencies: ['Baseline'] }),
      makeTask('Evaluation', { expected: 60, optimistic: 30, pessimistic: 90, dependencies: ['Comparison model'] }),
      makeTask('Test predictions', { expected: 60, optimistic: 30, pessimistic: 90, dependencies: ['Evaluation'] }),
      makeTask('Report', { expected: 90, optimistic: 45, pessimistic: 120, dependencies: ['Test predictions'] }),
      makeTask('Package submission', { expected: 60, optimistic: 30, pessimistic: 90, dependencies: ['Report'] }),
      makeTask('Optional bonus', { expected: 60, optimistic: 30, pessimistic: 90, is_optional: true, dependencies: ['Comparison model'] }),
    ],
    deadline.toISOString()
  );

  // Previous availability: 8 hours (480 mins). Schedules 7 blocks (480 mins). 2 tasks unscheduled.
  const previous = buildPlan(analysis, [window(480)]);
  assert.strictEqual(previous.scheduled_blocks.length, 7);

  // New availability: 4 hours (240 mins).
  const result = replan(analysis, previous, [window(240)]);

  // 3 blocks preserved
  assert.strictEqual(result.preserved_block_count, 3);
  // 4 blocks changed (1 partially rescheduled + 3 unscheduled from the previous 7 blocks)
  assert.strictEqual(result.changed_block_count, 4);

  // Comparison model is partially rescheduled
  const compChange = result.changes.find((c) => c.task_title === 'Comparison model')!;
  assert.strictEqual(compChange.change_type, 'partially_rescheduled');
  assert.strictEqual(compChange.reason, 'Only 60 of 90 minutes fit under the new availability.');

  // Feasibility changed to infeasible
  assert.strictEqual(result.new_status, 'infeasible');

  // No misleading "Deadline buffer increased" warning when mandatory work is unfinished
  assert(!result.warnings.some((w) => w.toLowerCase().includes('buffer increased')));
}

// 19. Firestore audit events contain only plan metadata
{
  const analysis = makeAnalysis([makeTask('Audit task', { expected: 60 })]);
  const plan = buildPlan(analysis, [window(120)]);
  const planEvent = buildPlanCreatedEvent(analysis, plan);

  assert.deepStrictEqual(planEvent, {
    event_type: 'plan_created',
    assignment_title: 'Planner test',
    feasibility: plan.feasibility.status,
    available_minutes: 120,
    expected_workload_minutes: 60,
    unfinished_task_count: 0,
  });

  const replanned = replan(analysis, plan, [window(30)]);
  const replanEvent = buildPlanReplannedEvent(analysis, replanned);

  assert.deepStrictEqual(replanEvent, {
    event_type: 'plan_replanned',
    assignment_title: 'Planner test',
    previous_feasibility: plan.feasibility.status,
    new_feasibility: replanned.feasibility.status,
    preserved_block_count: replanned.preserved_block_count,
    changed_block_count: replanned.changed_block_count,
    unfinished_task_count: replanned.unfinished_tasks.length,
  });
  assert(!('source_snippet' in planEvent));
}

console.log('All Planner and Replanner tests passed successfully!');
