import { existsSync } from 'node:fs';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Firestore, getFirestore } from 'firebase-admin/firestore';

import { AssignmentAnalysis, PlanResult, ReplanResponse } from '../types.js';

const EVENTS_COLLECTION = 'courseflow_events';

type FirestoreEvent = Record<string, string | number | FieldValue>;

let firestoreClient: Firestore | null | undefined;
let skippedWithoutCredentialsLogged = false;

function hasGoogleApplicationCredentials(): boolean {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return Boolean(credentialsPath && existsSync(credentialsPath));
}

function getFirestoreClient(): Firestore | null {
  if (firestoreClient !== undefined) {
    return firestoreClient;
  }

  if (!hasGoogleApplicationCredentials()) {
    firestoreClient = null;
    if (!skippedWithoutCredentialsLogged) {
      console.info('[Firestore] Persistence skipped: Google credentials unavailable.');
      skippedWithoutCredentialsLogged = true;
    }
    return firestoreClient;
  }

  try {
    const app = getApps()[0] ?? initializeApp({ credential: applicationDefault() });
    firestoreClient = getFirestore(app);
    console.info('[Firestore] Persistence initialized.');
  } catch (_error) {
    firestoreClient = null;
    console.error('[Firestore] Persistence initialization failed.');
  }

  return firestoreClient;
}

function persistEvent(event: FirestoreEvent): void {
  const firestore = getFirestoreClient();
  if (!firestore) {
    return;
  }

  try {
    void firestore
      .collection(EVENTS_COLLECTION)
      .add({ ...event, created_at: FieldValue.serverTimestamp() })
      .then(() => console.info(`[Firestore] Event persisted: ${event.event_type}.`))
      .catch(() => console.error(`[Firestore] Event write failed: ${event.event_type}.`));
  } catch (_error) {
    console.error(`[Firestore] Event write failed: ${event.event_type}.`);
  }
}

export function buildPlanCreatedEvent(
  analysis: AssignmentAnalysis,
  result: PlanResult
): FirestoreEvent {
  return {
    event_type: 'plan_created',
    assignment_title: analysis.title,
    feasibility: result.feasibility.status,
    available_minutes: result.feasibility.available_minutes,
    expected_workload_minutes: result.feasibility.expected_workload_minutes,
    unfinished_task_count: result.unfinished_tasks.length,
  };
}

export function buildPlanReplannedEvent(
  analysis: AssignmentAnalysis,
  result: ReplanResponse
): FirestoreEvent {
  return {
    event_type: 'plan_replanned',
    assignment_title: analysis.title,
    previous_feasibility: result.previous_status,
    new_feasibility: result.new_status,
    preserved_block_count: result.preserved_block_count,
    changed_block_count: result.changed_block_count,
    unfinished_task_count: result.unfinished_tasks.length,
  };
}

export function recordPlanCreated(
  analysis: AssignmentAnalysis,
  result: PlanResult
): void {
  persistEvent(buildPlanCreatedEvent(analysis, result));
}

export function recordPlanReplanned(
  analysis: AssignmentAnalysis,
  result: ReplanResponse
): void {
  persistEvent(buildPlanReplannedEvent(analysis, result));
}
