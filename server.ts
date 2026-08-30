import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import {
  AssignmentAnalysis,
  AvailabilityWindow,
  PlanResult,
} from './src/types.js';
import {
  PlannerError,
  buildPlan,
  normalizeAnalysis,
} from './src/services/planner.js';
import { replan } from './src/services/replanner.js';
import {
  DocumentProcessingError,
  extractPdfPages,
  formatPageBlocks,
} from './src/services/documentService.js';
import {
  SourceReferenceError,
  analyzeAssignment,
  analyzeAssignmentPages,
  validateSourceReferences,
} from './src/agent/courseAgent.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.url} (Origin: ${req.headers.origin || 'same-origin'}, Host: ${req.headers.host || 'unknown'})`
  );
  next();
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Static files
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 3,
  },
});

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Analyze plain text
app.post('/api/analyze', async (req: Request, res: Response) => {
  const payload = req.body;
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.text !== 'string'
  ) {
    res.status(400).json({ error: 'Request body must be JSON with a "text" string.' });
    return;
  }

  const assignmentText = payload.text.trim();
  if (!assignmentText) {
    res.status(400).json({ error: 'The "text" field cannot be empty.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error:
        'GOOGLE_API_KEY is not configured. Add it to the environment before running assignment analysis.',
    });
    return;
  }

  try {
    const rawAnalysis = await analyzeAssignment(assignmentText);
    const analysis = normalizeAnalysis(rawAnalysis);
    res.json(analysis);
  } catch (err: any) {
    console.error('Assignment analysis failed:', err);
    res.status(502).json({
      error:
        'The assignment could not be analyzed. Please try again or check the Gemini configuration.',
    });
  }
});

// Analyze uploaded PDFs
app.post(
  '/api/analyze-pdf',
  (req: Request, res: Response, next: NextFunction) => {
    upload.array('files', 3)(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            error: 'One or more files exceed the 10 MB per-file limit.',
          });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          res.status(400).json({
            error: 'A maximum of 3 PDF files can be analyzed.',
          });
          return;
        }
        res.status(400).json({ error: err.message || 'File upload error.' });
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    const files = req.files as Express.Multer.File[];
    console.log(`[API /api/analyze-pdf] Received ${files ? files.length : 0} file(s)`);
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No PDF files were supplied.' });
      return;
    }

    let pages;
    try {
      console.log(`[API /api/analyze-pdf] Extracting PDF pages from ${files.map(f => f.originalname).join(', ')}...`);
      pages = await extractPdfPages(files);
      console.log(`[API /api/analyze-pdf] Extracted ${pages.length} total pages`);
    } catch (error: any) {
      console.error('[API /api/analyze-pdf] PDF extraction error:', error.message);
      res.status(400).json({ error: error.message });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      console.warn('[API /api/analyze-pdf] Missing API key');
      res.status(503).json({
        error:
          'GOOGLE_API_KEY is not configured. Add it to the environment before running assignment analysis.',
      });
      return;
    }

    try {
      console.log('[API /api/analyze-pdf] Invoking Gemini assignment analysis...');
      const rawAnalysis = await analyzeAssignmentPages(
        formatPageBlocks(pages)
      );
      const analysis = normalizeAnalysis(rawAnalysis);

      const availablePages = new Map<string, Set<number>>();
      for (const page of pages) {
        if (!availablePages.has(page.source_file)) {
          availablePages.set(page.source_file, new Set());
        }
        availablePages.get(page.source_file)!.add(page.page_number);
      }

      validateSourceReferences(analysis, availablePages);
      console.log(`[API /api/analyze-pdf] Successfully analyzed coursework: "${analysis.title}", ${analysis.tasks.length} tasks`);
      res.json(analysis);
    } catch (err: any) {
      if (err instanceof SourceReferenceError) {
        console.error('[API /api/analyze-pdf] PDF source reference validation failed:', err);
        res.status(502).json({
          error:
            'Gemini returned an invalid source reference for the uploaded PDFs.',
        });
        return;
      }
      console.error('[API /api/analyze-pdf] PDF assignment analysis failed:', err);
      res.status(502).json({
        error:
          'The PDF assignment could not be analyzed. Please try again or check the Gemini configuration.',
      });
    }
  }
);

// Build Plan
app.post('/api/plan', (req: Request, res: Response) => {
  const payload = req.body;
  if (!payload || !payload.analysis || !Array.isArray(payload.availability)) {
    res.status(400).json({
      error:
        'Request body must contain a valid AssignmentAnalysis and timezone-aware availability windows.',
    });
    return;
  }

  try {
    const analysis = payload.analysis as AssignmentAnalysis;
    const availability = payload.availability as AvailabilityWindow[];
    const result = buildPlan(analysis, availability);
    res.json(result);
  } catch (err: any) {
    if (err instanceof PlannerError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('Plan calculation error:', err);
    res.status(400).json({
      error:
        'Request body must contain a valid AssignmentAnalysis and timezone-aware availability windows.',
    });
  }
});

// Replan
app.post('/api/replan', (req: Request, res: Response) => {
  const payload = req.body;
  if (
    !payload ||
    !payload.analysis ||
    !payload.previous_plan ||
    !Array.isArray(payload.new_availability)
  ) {
    res.status(400).json({
      error:
        'Request body must contain a valid AssignmentAnalysis, previous plan, and timezone-aware new availability.',
    });
    return;
  }

  try {
    const analysis = payload.analysis as AssignmentAnalysis;
    const previousPlan = payload.previous_plan as PlanResult;
    const newAvailability = payload.new_availability as AvailabilityWindow[];
    const result = replan(analysis, previousPlan, newAvailability);
    res.json(result);
  } catch (err: any) {
    if (err instanceof PlannerError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('Replan calculation error:', err);
    res.status(400).json({
      error:
        'Request body must contain a valid AssignmentAnalysis, previous plan, and timezone-aware new availability.',
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`CourseFlow server running on http://0.0.0.0:${port}`);
});
