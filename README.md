\# CourseFlow



CourseFlow turns an assignment brief into a grounded, workload-aware execution plan.



Upload coursework PDFs, let the AI extract the deadline, deliverables, requirements, ambiguities, and actionable tasks with source evidence, then enter your available study time. CourseFlow estimates the workload, checks whether the work is feasible, and builds a schedule around the time you actually have.



\## Why CourseFlow



Students often know what they need to submit but still struggle with a harder question: \*\*can I realistically finish this work with the time I have left?\*\*



CourseFlow combines AI document understanding with deterministic scheduling so the answer is more useful than a generic checklist. It keeps extracted requirements tied to page-level evidence, estimates task effort using optimistic / expected / pessimistic ranges, prioritizes required work over optional work, and reports unfinished work when the available time is not enough.



\## Core features



\- PDF coursework analysis

\- Grounded extraction with source-file and page references

\- Deadline, deliverable, requirement, ambiguity, and task extraction

\- Optimistic, expected, and pessimistic workload estimates

\- Feasibility assessment against real available time

\- Deterministic schedule generation

\- Required work prioritized over optional work

\- Replanning when availability changes

\- Firestore event persistence

\- Production deployment on Render



\## How it works



1\. The user uploads one or more assignment PDFs.

2\. CourseFlow extracts page-aware text and sends structured coursework context to Gemini.

3\. Gemini returns structured assignment analysis with evidence-backed tasks and workload estimates.

4\. The user enters availability windows.

5\. CourseFlow's deterministic planner creates an execution schedule.

6\. If availability changes, the replanner produces an updated plan.

7\. Plan creation and replanning events can be persisted to Firestore.



\## Architecture



```mermaid

flowchart LR

&#x20;   U\[Student] --> UI\[CourseFlow Web UI]

&#x20;   UI -->|PDF upload| API\[Express / TypeScript API]

&#x20;   API --> DOC\[PDF Document Service]

&#x20;   DOC -->|Page-aware text| AGENT\[Course Agent]

&#x20;   AGENT -->|Structured prompt| GEMINI\[Google Gemini]

&#x20;   GEMINI -->|Grounded analysis| AGENT

&#x20;   AGENT --> VALIDATE\[Evidence + schema validation]

&#x20;   VALIDATE --> UI



&#x20;   UI -->|Analysis + availability| PLAN\[Deterministic Planner]

&#x20;   PLAN -->|Execution plan + feasibility| UI



&#x20;   UI -->|Changed availability| REPLAN\[Replanner]

&#x20;   REPLAN -->|Updated schedule| UI



&#x20;   PLAN --> FIRESTORE\[(Cloud Firestore)]

&#x20;   REPLAN --> FIRESTORE

