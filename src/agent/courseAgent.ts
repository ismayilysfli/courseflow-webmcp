import { GoogleGenAI, Type } from '@google/genai';
import { AssignmentAnalysis, SourceEvidence } from '../types.js';
import {
  SYSTEM_INSTRUCTION,
  buildAssignmentPrompt,
  buildPdfAssignmentPrompt,
} from './prompts.js';

export class SourceReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceReferenceError';
  }
}

const sourceEvidenceSchema = {
  type: Type.OBJECT,
  properties: {
    source_file: { type: Type.STRING },
    page_number: { type: Type.INTEGER, nullable: true },
    source_snippet: { type: Type.STRING },
  },
  required: ['source_file', 'source_snippet'],
};

const evidenceBackedFactSchema = {
  type: Type.OBJECT,
  properties: {
    fact: { type: Type.STRING },
    is_optional: { type: Type.BOOLEAN, nullable: true },
    evidence: {
      type: Type.ARRAY,
      items: sourceEvidenceSchema,
    },
  },
  required: ['fact'],
};

const taskEstimateSchema = {
  type: Type.OBJECT,
  properties: {
    task_id: { type: Type.STRING, nullable: true },
    title: { type: Type.STRING },
    description: { type: Type.STRING },
    source_requirement: { type: Type.STRING },
    dependencies: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    optimistic_minutes: { type: Type.INTEGER },
    expected_minutes: { type: Type.INTEGER },
    pessimistic_minutes: { type: Type.INTEGER },
    confidence: {
      type: Type.STRING,
      enum: ['low', 'medium', 'high'],
    },
    estimation_reason: { type: Type.STRING },
    is_optional: {
      type: Type.BOOLEAN,
      description: 'True if this task is optional or bonus work; false if mandatory.',
    },
    evidence: {
      type: Type.ARRAY,
      items: sourceEvidenceSchema,
    },
  },
  required: [
    'title',
    'description',
    'source_requirement',
    'dependencies',
    'optimistic_minutes',
    'expected_minutes',
    'pessimistic_minutes',
    'confidence',
    'estimation_reason',
    'is_optional',
  ],
};

const assignmentAnalysisSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    deadline: { type: Type.STRING, nullable: true },
    deadline_iso: { type: Type.STRING, nullable: true },
    deadline_evidence: {
      type: Type.ARRAY,
      items: sourceEvidenceSchema,
    },
    deliverables: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    deliverable_evidence: {
      type: Type.ARRAY,
      items: evidenceBackedFactSchema,
    },
    requirements: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    requirement_evidence: {
      type: Type.ARRAY,
      items: evidenceBackedFactSchema,
    },
    ambiguities: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    tasks: {
      type: Type.ARRAY,
      items: taskEstimateSchema,
    },
  },
  required: ['title', 'deliverables', 'requirements', 'ambiguities', 'tasks'],
};

function getGenAI(): GoogleGenAI {
  const apiKey =
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const MODELS = ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];

async function runGeminiWithRetry(prompt: string): Promise<AssignmentAnalysis> {
  const ai = getGenAI();
  let lastError: any = null;

  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: assignmentAnalysisSchema,
        },
      });

      const text = response.text?.trim();
      if (!text) {
        throw new Error('Gemini returned an empty response.');
      }

      const parsed: AssignmentAnalysis = JSON.parse(text);

      // Validate estimate order: optimistic <= expected <= pessimistic
      if (parsed.tasks) {
        for (const task of parsed.tasks) {
          if (
            !(
              task.optimistic_minutes <= task.expected_minutes &&
              task.expected_minutes <= task.pessimistic_minutes
            )
          ) {
            const sorted = [
              task.optimistic_minutes,
              task.expected_minutes,
              task.pessimistic_minutes,
            ].sort((a, b) => a - b);
            task.optimistic_minutes = sorted[0];
            task.expected_minutes = sorted[1];
            task.pessimistic_minutes = sorted[2];
          }
        }
      }

      console.log(`[courseAgent] Assignment analysis succeeded using model: ${model}`);
      return parsed;
    } catch (err: any) {
      lastError = err;
      const isUnavailable =
        err?.status === 503 ||
        err?.code === 503 ||
        (typeof err?.message === 'string' &&
          (err.message.includes('503') ||
            err.message.includes('UNAVAILABLE') ||
            err.message.includes('high demand') ||
            err.message.includes('ResourceExhausted')));

      if (isUnavailable) {
        console.log(`[courseAgent] ${model} unavailable (high demand), switching to fallback model...`);
      } else {
        console.log(`[courseAgent] ${model} attempt failed: ${err?.message || err}, switching to fallback...`);
      }
    }
  }

  throw lastError || new Error('Failed to analyze assignment with Gemini.');
}

export async function analyzeAssignment(
  assignmentText: string
): Promise<AssignmentAnalysis> {
  return runGeminiWithRetry(buildAssignmentPrompt(assignmentText));
}

export async function analyzeAssignmentPages(
  pageBlocks: string
): Promise<AssignmentAnalysis> {
  return runGeminiWithRetry(buildPdfAssignmentPrompt(pageBlocks));
}

export function validateSourceReferences(
  analysis: AssignmentAnalysis,
  availablePages: Map<string, Set<number>>
): void {
  const evidenceItems: SourceEvidence[] = [
    ...(analysis.deadline_evidence || []),
    ...(analysis.deliverable_evidence || []).flatMap((d) => d.evidence || []),
    ...(analysis.requirement_evidence || []).flatMap((r) => r.evidence || []),
    ...(analysis.tasks || []).flatMap((t) => t.evidence || []),
  ];

  for (const evidence of evidenceItems) {
    if (!availablePages.has(evidence.source_file)) {
      throw new SourceReferenceError(
        `Gemini cited an uploaded file that was not supplied: ${evidence.source_file}`
      );
    }
    if (evidence.page_number === undefined || evidence.page_number === null) {
      throw new SourceReferenceError(
        `Gemini did not provide a page number for ${evidence.source_file}.`
      );
    }
    const pagesForFile = availablePages.get(evidence.source_file)!;
    if (!pagesForFile.has(evidence.page_number)) {
      throw new SourceReferenceError(
        `Gemini cited page ${evidence.page_number} of ${evidence.source_file}, but that page does not exist.`
      );
    }
  }

  if (analysis.deadline !== null && analysis.deadline !== undefined && (!analysis.deadline_evidence || analysis.deadline_evidence.length === 0)) {
    throw new SourceReferenceError(
      'The extracted deadline did not include source evidence.'
    );
  }

  const deliverableEvidence = new Map<string, SourceEvidence[]>();
  for (const sourcedFact of analysis.deliverable_evidence || []) {
    deliverableEvidence.set(sourcedFact.fact, sourcedFact.evidence || []);
  }

  for (const deliverable of analysis.deliverables || []) {
    const ev = deliverableEvidence.get(deliverable);
    if (!ev || ev.length === 0) {
      throw new SourceReferenceError(
        `The deliverable ${JSON.stringify(deliverable)} did not include source evidence.`
      );
    }
  }

  const reqEvidence = new Map<string, SourceEvidence[]>();
  for (const sourcedFact of analysis.requirement_evidence || []) {
    reqEvidence.set(sourcedFact.fact, sourcedFact.evidence || []);
  }

  for (const requirement of analysis.requirements || []) {
    const ev = reqEvidence.get(requirement);
    if (!ev || ev.length === 0) {
      throw new SourceReferenceError(
        `The requirement ${JSON.stringify(requirement)} did not include source evidence.`
      );
    }
  }

  for (const task of analysis.tasks || []) {
    if (task.source_requirement && (!task.evidence || task.evidence.length === 0)) {
      throw new SourceReferenceError(
        `The task ${JSON.stringify(task.title)} did not include source evidence.`
      );
    }
  }
}
