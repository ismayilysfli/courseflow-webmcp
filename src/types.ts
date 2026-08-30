export type Confidence = 'low' | 'medium' | 'high';

export interface SourceEvidence {
  source_file: string;
  page_number?: number | null;
  source_snippet: string;
}

export interface EvidenceBackedFact {
  fact: string;
  is_optional?: boolean;
  evidence: SourceEvidence[];
}

export interface TaskEstimate {
  task_id?: string | null;
  title: string;
  description: string;
  source_requirement: string;
  dependencies: string[];
  optimistic_minutes: number;
  expected_minutes: number;
  pessimistic_minutes: number;
  confidence: Confidence;
  estimation_reason: string;
  is_optional?: boolean;
  evidence: SourceEvidence[];
}

export interface AssignmentAnalysis {
  title: string;
  deadline?: string | null;
  deadline_iso?: string | null;
  deadline_evidence?: SourceEvidence[];
  deliverables?: string[];
  deliverable_evidence?: EvidenceBackedFact[];
  requirements?: string[];
  requirement_evidence?: EvidenceBackedFact[];
  ambiguities?: string[];
  tasks: TaskEstimate[];
}

export interface AvailabilityWindow {
  start: string; // ISO 8601 string with timezone offset
  end: string;   // ISO 8601 string with timezone offset
}

export interface ScheduledBlock {
  task_id: string;
  task_title: string;
  start: string; // ISO 8601
  end: string;   // ISO 8601
  scheduled_minutes: number;
}

export interface TaskScheduleSummary {
  task_id: string;
  total_required_minutes: number;
  total_scheduled_minutes: number;
  completed_in_plan: boolean;
}

export type FeasibilityStatus = 'comfortable' | 'tight' | 'at_risk' | 'infeasible';

export interface FeasibilitySummary {
  available_minutes: number;
  optimistic_workload_minutes: number;
  expected_workload_minutes: number;
  pessimistic_workload_minutes: number;
  expected_shortfall_minutes: number;
  optimistic_shortfall_minutes: number;
  status: FeasibilityStatus;
  warnings: string[];
}

export interface PlanResult {
  feasibility: FeasibilitySummary;
  scheduled_blocks: ScheduledBlock[];
  task_summaries: TaskScheduleSummary[];
  deadline_buffer_minutes: number | null;
  warnings: string[];
  unfinished_tasks: string[];
}

export type ReplanChangeType =
  | 'preserved'
  | 'moved'
  | 'rescheduled'
  | 'split'
  | 'unscheduled'
  | 'partially_rescheduled';

export interface PlanChange {
  task_id: string;
  task_title: string;
  change_type: ReplanChangeType;
  old_blocks: ScheduledBlock[];
  new_blocks: ScheduledBlock[];
  reason: string;
}

export interface ReplanResponse {
  feasibility: FeasibilitySummary;
  scheduled_blocks: ScheduledBlock[];
  task_summaries: TaskScheduleSummary[];
  deadline_buffer_minutes: number | null;
  changes: PlanChange[];
  preserved_block_count: number;
  changed_block_count: number;
  warnings: string[];
  unfinished_tasks: string[];
  previous_status: FeasibilityStatus;
  new_status: FeasibilityStatus;
  previous_deadline_buffer_minutes: number | null;
  new_deadline_buffer_minutes: number | null;
}
