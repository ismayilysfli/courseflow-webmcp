const state = {
    pdfs: [],
    analysis: null,
    availability: [],
    plan: null,
    replanAvailability: [],
    replanResult: null,
    activity: [],
    workflowVersion: 0,
};

// Utilities
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatMinutes(mins) {
    if (typeof mins !== 'number' || isNaN(mins)) return '0m';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
}

function formatToIso(dateStr, timeStr) {
    const d = new Date(`${dateStr}T${timeStr}`);
    return d.toISOString();
}

function formatDate(isoStr) {
    return new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTime(isoStr) {
    return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function taskTitleForId(taskId) {
    const task = state.analysis && state.analysis.tasks
        ? state.analysis.tasks.find(candidate => candidate.task_id === taskId)
        : null;
    return task ? task.title : taskId;
}

function displayWarning(warning) {
    if (typeof warning !== "string" || !state.analysis || !state.analysis.tasks) return warning;
    return [...state.analysis.tasks]
        .sort((a, b) => b.task_id.length - a.task_id.length)
        .reduce(
        (displayText, task) => displayText.split(task.task_id).join(task.title),
        warning
        );
}

function showError(elementId, message) {
    const el = document.getElementById(elementId);
    el.textContent = message;
    el.classList.remove("hidden");
}

function hideError(elementId) {
    const el = document.getElementById(elementId);
    el.classList.add("hidden");
    el.textContent = "";
}

function responseError(response, data, fallback, temporaryMessage = null) {
    if (response.status === 502 && temporaryMessage) {
        return temporaryMessage;
    }
    return data && typeof data.error === "string" ? data.error : fallback;
}

function addActivity(message) {
    state.activity.push(message);
    const log = document.getElementById("activity-log");
    const items = document.getElementById("activity-items");
    log.classList.remove("hidden");
    items.innerHTML = state.activity.map((item, index) => `
        <li data-testid="activity-item-${index}">
            <span class="activity-state" aria-hidden="true">Done</span>
            ${escapeHtml(item)}
        </li>
    `).join("");
}

async function apiFetch(endpoint, options = {}) {
    const fullUrl = new URL(endpoint, window.location.origin).href;
    console.log(`[CourseFlow Client] API Request: ${options.method || 'GET'} ${fullUrl} (Origin: ${window.location.origin})`);
    try {
        const response = await fetch(endpoint, {
            ...options,
            credentials: 'include',
        });
        console.log(`[CourseFlow Client] API Response: ${response.status} for ${endpoint}`);
        return response;
    } catch (err) {
        console.error(`[CourseFlow Client] Network/Fetch error for ${fullUrl}:`, err);
        throw err;
    }
}

// Navigation
document.getElementById("btn-build-plan").addEventListener("click", () => {
    document.getElementById("landing-page").classList.remove("view-active");
    document.getElementById("landing-page").classList.add("view-hidden");
    document.getElementById("workspace-page").classList.remove("view-hidden");
    showStage("stage-documents");
});

document.getElementById("logo-home").addEventListener("click", () => {
    // Reset state and go back to landing
    state.workflowVersion += 1;
    state.pdfs = [];
    state.analysis = null;
    state.availability = [];
    state.plan = null;
    state.replanAvailability = [];
    state.replanResult = null;
    state.activity = [];
    
    renderFileList();
    document.getElementById("analysis-results").classList.add("hidden");
    document.getElementById("activity-log").classList.add("hidden");
    document.getElementById("analyze-loading").classList.add("hidden");
    document.getElementById("plan-loading").classList.add("hidden");
    document.getElementById("replan-loading").classList.add("hidden");
    document.getElementById("btn-generate-plan").disabled = false;
    document.getElementById("btn-execute-replan").disabled = false;
    updateAnalyzeButton();
    updateNavigationAccess();
    
    document.getElementById("workspace-page").classList.add("view-hidden");
    document.getElementById("landing-page").classList.remove("view-hidden");
    document.getElementById("landing-page").classList.add("view-active");
});

document.getElementById("logo-home").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        document.getElementById("logo-home").click();
    }
});

function showStage(stageId) {
    ["stage-documents", "stage-availability", "stage-plan", "stage-replan"].forEach(s => {
        document.getElementById(s).classList.add("stage-hidden");
        document.getElementById(s).classList.remove("stage-active");
    });
    document.getElementById(stageId).classList.remove("stage-hidden");
    document.getElementById(stageId).classList.add("stage-active");
    
    ["nav-step-docs", "nav-step-avail", "nav-step-plan", "nav-step-replan"].forEach(n => {
        const navItem = document.getElementById(n);
        navItem.classList.remove("active");
        navItem.removeAttribute("aria-current");
    });
    
    if (stageId === "stage-documents") document.getElementById("nav-step-docs").classList.add("active");
    if (stageId === "stage-availability") document.getElementById("nav-step-avail").classList.add("active");
    if (stageId === "stage-plan") document.getElementById("nav-step-plan").classList.add("active");
    if (stageId === "stage-replan") document.getElementById("nav-step-replan").classList.add("active");

    const activeNav = document.querySelector(".nav-step.active");
    if (activeNav) activeNav.setAttribute("aria-current", "step");
    updateProgressState(stageId);
}

function updateNavigationAccess() {
    document.getElementById("nav-step-avail").disabled = !state.analysis;
    document.getElementById("nav-step-plan").disabled = !state.plan;
    document.getElementById("nav-step-replan").disabled = !state.plan;
    const activeStage = document.querySelector(".stage-active");
    updateProgressState(activeStage ? activeStage.id : "stage-documents");
}

function updateProgressState(activeStageId) {
    const completed = {
        "nav-step-docs": Boolean(state.analysis) && activeStageId !== "stage-documents",
        "nav-step-avail": Boolean(state.plan) && activeStageId !== "stage-availability",
        "nav-step-plan": Boolean(state.plan) && activeStageId === "stage-replan",
        "nav-step-replan": false,
    };

    Object.entries(completed).forEach(([id, isCompleted]) => {
        document.getElementById(id).classList.toggle("completed", isCompleted);
    });
}

document.querySelectorAll(".nav-step").forEach(button => {
    button.addEventListener("click", () => {
        const stageId = button.dataset.stage;
        if (stageId === "stage-replan") {
            openReplanStage();
            return;
        }
        if (stageId === "stage-availability" && state.availability.length === 0) {
            addDefaultAvailability();
        }
        if (stageId === "stage-availability") {
            renderAvailabilityList("avail-list", state.availability, false);
        }
        showStage(stageId);
    });
});

// Stage 1: Documents
const dropArea = document.getElementById("upload-area");
const fileInput = document.getElementById("pdf-input");

dropArea.addEventListener("click", () => fileInput.click());
dropArea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
    }
});

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, preventDefaults, false);
});
function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    dropArea.addEventListener(eventName, () => dropArea.classList.add("is-dragging"));
});
['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, () => dropArea.classList.remove("is-dragging"));
});

dropArea.addEventListener("drop", (e) => {
    handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener("change", function() {
    handleFiles(this.files);
    this.value = ""; 
});

function handleFiles(files) {
    hideError("doc-error");
    
    let validFiles = [];
    for (let i = 0; i < files.length; i++) {
        const isPdf = files[i].type === "application/pdf"
            || files[i].name.toLowerCase().endsWith(".pdf");
        if (!isPdf) {
            showError("doc-error", "Only PDF files are supported.");
            return;
        }
        validFiles.push(files[i]);
    }
    
    if (state.pdfs.length + validFiles.length > 3) {
        showError("doc-error", "You can upload a maximum of 3 PDFs.");
        return;
    }
    
    state.pdfs.push(...validFiles);
    renderFileList();
    updateAnalyzeButton();
}

function renderFileList() {
    const list = document.getElementById("file-list");
    list.innerHTML = state.pdfs.map((f, i) => `
        <div class="file-item" data-testid="file-item-${i}">
            <div class="file-info">
                <span class="file-type-icon" aria-hidden="true">PDF</span>
                <span class="file-copy">
                <span class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
                    <span class="file-size">${formatBytes(f.size)} · Ready to analyze</span>
                </span>
            </div>
            <button type="button" class="button button-danger-icon btn-remove-pdf" aria-label="Remove ${escapeHtml(f.name)}" data-index="${i}" data-testid="remove-file-${i}">&times;</button>
        </div>
    `).join("");
}

document.getElementById("file-list").addEventListener("click", e => {
    const btn = e.target.closest('.btn-remove-pdf');
    if (btn) {
        const index = parseInt(btn.getAttribute("data-index"), 10);
        state.pdfs.splice(index, 1);
        renderFileList();
        updateAnalyzeButton();
    }
});

function updateAnalyzeButton() {
    document.getElementById("btn-analyze").disabled = state.pdfs.length === 0;
}

document.getElementById("btn-analyze").addEventListener("click", async () => {
    hideError("doc-error");
    if (state.pdfs.length === 0) return;
    state.workflowVersion += 1;
    const requestVersion = state.workflowVersion;
    
    document.getElementById("btn-analyze").disabled = true;
    document.getElementById("analyze-loading").classList.remove("hidden");
    document.getElementById("analysis-results").classList.add("hidden");
    
    const formData = new FormData();
    state.pdfs.forEach(f => formData.append("files", f));

    try {
        const res = await apiFetch("/api/analyze-pdf", {
            method: "POST",
            body: formData
        });
        
        let data;
        try {
            data = await res.json();
        } catch (e) {
            throw new Error("Invalid response from server.");
        }
        
        if (!res.ok) {
            throw new Error(responseError(
                res,
                data,
                "CourseFlow could not analyze the documents right now. Please try again.",
                "CourseFlow could not analyze the documents right now. Please try again."
            ));
        }
        if (requestVersion !== state.workflowVersion) return;
        
        state.analysis = data;
        state.plan = null;
        state.replanResult = null;
        state.activity = [];
        renderAnalysis();
        updateNavigationAccess();
        addActivity(`Read ${state.pdfs.length} document${state.pdfs.length === 1 ? "" : "s"}`);
        addActivity(`Extracted ${(data.requirement_evidence || []).length} requirements`);
        addActivity(`Created ${(data.tasks || []).length} tasks`);
    } catch (err) {
        if (requestVersion !== state.workflowVersion) return;
        showError(
            "doc-error",
            err.message || "CourseFlow could not analyze the documents right now. Please try again."
        );
    } finally {
        if (requestVersion === state.workflowVersion) {
            updateAnalyzeButton();
            document.getElementById("analyze-loading").classList.add("hidden");
        }
    }
});

function renderAnalysis() {
    const data = state.analysis;
    const container = document.getElementById("analysis-results");
    container.classList.remove("hidden");
    
    document.getElementById("analysis-title").textContent = data.title;
    document.getElementById("analysis-deadline").textContent = data.deadline_iso ? new Date(data.deadline_iso).toLocaleString() : (data.deadline || "No deadline found");
    
    const renderEvidences = (evList) => {
        if (!evList || !evList.length) return "";
        return evList.map(e => `
            <details class="evidence-details" data-testid="evidence-details">
                <summary>
                    <span class="evidence-source" title="${escapeHtml(e.source_file)}">${escapeHtml(e.source_file)}</span>
                    ${e.page_number ? `<span class="evidence-page">Page ${e.page_number}</span>` : ""}
                </summary>
                <div class="evidence-snippet">“${escapeHtml(e.source_snippet)}”</div>
            </details>
        `).join("");
    };

    const deadlineEvidenceContainer = document.getElementById("analysis-deadline-evidence");
    if (deadlineEvidenceContainer) {
        if (data.deadline_evidence && data.deadline_evidence.length) {
            deadlineEvidenceContainer.innerHTML = renderEvidences(data.deadline_evidence);
            deadlineEvidenceContainer.classList.remove("hidden");
        } else {
            deadlineEvidenceContainer.innerHTML = "";
            deadlineEvidenceContainer.classList.add("hidden");
        }
    }

    const delContainer = document.getElementById("analysis-deliverables");
    if (data.deliverable_evidence && data.deliverable_evidence.length) {
        delContainer.innerHTML = data.deliverable_evidence.map((d, index) => `<li data-testid="deliverable-${index}">
            <div class="fact-text"><span class="fact-content"><span class="fact-bullet" aria-hidden="true"></span><span>${escapeHtml(d.fact)}</span></span></div>
            ${renderEvidences(d.evidence)}
        </li>`).join("");
    } else {
        delContainer.innerHTML = `<li class="empty-state">No deliverables extracted.</li>`;
    }

    const reqContainer = document.getElementById("analysis-requirements");
    if (data.requirement_evidence && data.requirement_evidence.length) {
        reqContainer.innerHTML = data.requirement_evidence.map((r, index) => `<li data-testid="requirement-${index}">
            <div class="fact-text">
                <span class="fact-content"><span class="fact-bullet" aria-hidden="true"></span><span>${escapeHtml(r.fact)}</span></span>
                ${r.is_optional
                    ? `<span class="badge badge-optional" data-testid="badge-optional-req-${index}">Optional</span>`
                    : `<span class="badge badge-required" data-testid="badge-required-req-${index}">Required</span>`}
            </div>
            ${renderEvidences(r.evidence)}
        </li>`).join("");
    } else {
        reqContainer.innerHTML = `<li class="empty-state">No specific requirements extracted.</li>`;
    }
    
    const ambContainer = document.getElementById("analysis-ambiguities");
    if (data.ambiguities && data.ambiguities.length) {
        ambContainer.innerHTML = data.ambiguities.map(
            (a, index) => `<li data-testid="ambiguity-${index}"><div class="fact-text"><span class="fact-content"><span class="fact-bullet" aria-hidden="true"></span><span>${escapeHtml(a)}</span></span></div></li>`
        ).join("");
    } else {
        ambContainer.innerHTML = `<li class="empty-state">No ambiguities found.</li>`;
    }
    
    const taskContainer = document.getElementById("analysis-tasks");
    taskContainer.innerHTML = data.tasks.map(t => `
        <div class="task-card" data-testid="task-card-${escapeHtml(t.task_id)}">
            <div class="task-card-header">
                <h5>${escapeHtml(t.title)}</h5>
                ${t.is_optional
                    ? `<span class="badge badge-optional" data-testid="badge-optional-${escapeHtml(t.task_id)}">Optional</span>`
                    : `<span class="badge badge-required">Required</span>`}
            </div>
            <p class="task-desc">${escapeHtml(t.description)}</p>
            <div class="task-meta">
                <div class="confidence-block"><span class="meta-caption">Estimate confidence</span><span class="conf-badge conf-${t.confidence}">${t.confidence}</span></div>
                <div class="estimate-block"><span class="meta-caption">Workload range</span><span class="est-times"><span>Optimistic ${formatMinutes(t.optimistic_minutes)}</span><span>Expected ${formatMinutes(t.expected_minutes)}</span><span>Pessimistic ${formatMinutes(t.pessimistic_minutes)}</span></span></div>
            </div>
            ${t.dependencies && t.dependencies.length ? `<div class="task-deps"><strong>Dependencies:</strong> ${t.dependencies.map(escapeHtml).join(", ")}</div>` : ""}
            <div class="task-reason"><strong>Reasoning:</strong> ${escapeHtml(t.estimation_reason)}</div>
            ${renderEvidences(t.evidence)}
        </div>
    `).join("");
}

function addDefaultAvailability() {
    if (state.availability.length === 0) {
        const d = new Date();
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        state.availability = [{ date: `${yyyy}-${mm}-${dd}`, start: "09:00", end: "17:00" }];
    }
}

document.getElementById("btn-next-availability").addEventListener("click", () => {
    addDefaultAvailability();
    renderAvailabilityList("avail-list", state.availability, false);
    showStage("stage-availability");
});

// Stage 2: Availability
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
document.getElementById("tz-display").textContent = tz || "Local Time";

function invalidatePlanAfterAvailabilityChange() {
    state.plan = null;
    state.replanAvailability = [];
    state.replanResult = null;
    document.getElementById("replan-results").classList.add("hidden");
    updateNavigationAccess();
}

function renderAvailabilityList(containerId, dataArray, isReplan = false) {
    const container = document.getElementById(containerId);
    container.innerHTML = dataArray.map((avail, index) => `
        <div class="avail-row" data-index="${index}">
            <span class="window-number" aria-hidden="true">${index + 1}</span>
            <div class="avail-group">
                <label for="${containerId}-date-${index}">Date</label>
                <input id="${containerId}-date-${index}" type="date" class="avail-date input-field" value="${escapeHtml(avail.date)}" data-testid="input-avail-date-${index}">
            </div>
            <div class="avail-group">
                <label for="${containerId}-start-${index}">Start time</label>
                <input id="${containerId}-start-${index}" type="time" class="avail-start input-field" value="${escapeHtml(avail.start)}" data-testid="input-avail-start-${index}">
            </div>
            <span class="time-separator" aria-hidden="true">to</span>
            <div class="avail-group">
                <label for="${containerId}-end-${index}">End time</label>
                <input id="${containerId}-end-${index}" type="time" class="avail-end input-field" value="${escapeHtml(avail.end)}" data-testid="input-avail-end-${index}">
            </div>
            <button type="button" class="button button-danger-icon btn-remove-avail" aria-label="Remove window" data-testid="button-remove-avail-${index}">
                &times;
            </button>
        </div>
    `).join("");

    container.querySelectorAll(".avail-row").forEach(row => {
        const idx = parseInt(row.getAttribute("data-index"));
        const stateArr = isReplan ? state.replanAvailability : state.availability;

        row.querySelector(".avail-date").addEventListener("change", (e) => stateArr[idx].date = e.target.value);
        row.querySelector(".avail-start").addEventListener("change", (e) => stateArr[idx].start = e.target.value);
        row.querySelector(".avail-end").addEventListener("change", (e) => stateArr[idx].end = e.target.value);
        
        row.querySelector(".btn-remove-avail").addEventListener("click", () => {
            stateArr.splice(idx, 1);
            renderAvailabilityList(containerId, stateArr, isReplan);
        });
    });
}

document.getElementById("btn-add-avail").addEventListener("click", () => {
    const last = state.availability[state.availability.length - 1];
    state.availability.push({ 
        date: last ? last.date : "", 
        start: last ? last.start : "09:00", 
        end: last ? last.end : "17:00" 
    });
    renderAvailabilityList("avail-list", state.availability, false);
});

document.getElementById("btn-back-docs").addEventListener("click", () => showStage("stage-documents"));

function validateAvailability(availArray) {
    if (availArray.length === 0) return "At least one availability window is required.";
    for (let i = 0; i < availArray.length; i++) {
        const { date, start, end } = availArray[i];
        if (!date || !start || !end) return `Row ${i + 1}: Date, start, and end times are required.`;
        const dStart = new Date(`${date}T${start}`);
        const dEnd = new Date(`${date}T${end}`);
        if (isNaN(dStart.getTime()) || isNaN(dEnd.getTime())) return `Row ${i + 1}: Invalid date or time format.`;
        if (dEnd <= dStart) return `Row ${i + 1}: End time must be after start time.`;
    }
    return null;
}

async function createExecutionPlanFromCurrentState(requestVersion = state.workflowVersion) {
    if (!state.analysis) {
        throw new Error("Coursework must be analyzed before an execution plan can be created.");
    }

    const payload = {
        analysis: state.analysis,
        availability: state.availability.map(a => ({
            start: formatToIso(a.date, a.start),
            end: formatToIso(a.date, a.end)
        }))
    };
    
    document.getElementById("btn-generate-plan").disabled = true;
    document.getElementById("plan-loading").classList.remove("hidden");

    try {
        const res = await apiFetch("/api/plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        
        let data;
        try {
            data = await res.json();
        } catch (e) {
            throw new Error("Invalid response from server.");
        }
        if (!res.ok) {
            throw new Error(responseError(
                res,
                data,
                "CourseFlow could not build the plan. Check your availability and try again."
            ));
        }
        if (requestVersion !== state.workflowVersion) return null;

        state.plan = data;
        renderPlan();
        updateNavigationAccess();
        addActivity(`Checked schedule feasibility: ${data.feasibility.status.replace("_", " ")}`);
        addActivity(`Built an execution plan with ${data.scheduled_blocks.length} scheduled block${data.scheduled_blocks.length === 1 ? "" : "s"}`);
        showStage("stage-plan");
        return data;
    } finally {
        if (requestVersion === state.workflowVersion) {
            document.getElementById("btn-generate-plan").disabled = false;
            document.getElementById("plan-loading").classList.add("hidden");
        }
    }
}

document.getElementById("btn-generate-plan").addEventListener("click", async () => {
    const errorMsg = validateAvailability(state.availability);
    if (errorMsg) {
        showError("avail-error", errorMsg);
        return;
    }
    hideError("avail-error");
    const requestVersion = state.workflowVersion;

    try {
        await createExecutionPlanFromCurrentState(requestVersion);
    } catch (err) {
        if (requestVersion !== state.workflowVersion) return;
        showError(
            "avail-error",
            err.message || "CourseFlow could not build the plan. Check your availability and try again."
        );
    }
});

// Stage 3: Plan
function renderPlan() {
    const p = state.plan;
    const feasCard = document.getElementById("plan-feasibility");
    const feasibilityLabels = {
        comfortable: "Feasible",
        tight: "At Risk",
        at_risk: "At Risk",
        infeasible: "Infeasible",
    };
    
    const mandatoryTasks = (state.analysis && state.analysis.tasks) ? state.analysis.tasks.filter(t => !t.is_optional) : [];
    const hasUnfinishedMandatory = p.unfinished_tasks && p.unfinished_tasks.some(id =>
        mandatoryTasks.some(t => t.task_id === id)
    );
    let bufferDisplay;
    if (hasUnfinishedMandatory || p.feasibility.status === 'infeasible') {
        bufferDisplay = "N/A - mandatory work remains unfinished";
    } else if (p.deadline_buffer_minutes !== null) {
        bufferDisplay = formatMinutes(p.deadline_buffer_minutes);
    } else {
        bufferDisplay = "Not available";
    }

    feasCard.className = `feasibility-card status-${p.feasibility.status}`;
    feasCard.innerHTML = `
        <div class="feas-header">
            <div class="feas-title-row">
                <div class="feas-title-copy"><span class="feas-eyebrow">Plan health</span><h3>Feasibility assessment</h3></div>
                <span class="status-label">${feasibilityLabels[p.feasibility.status] || p.feasibility.status.replace(/_/g, " ")}</span>
            </div>
            <div class="feas-metrics">
                <span class="feas-metric" data-testid="metric-available"><span class="feas-metric-label">Available time</span><strong>${formatMinutes(p.feasibility.available_minutes)}</strong></span>
                <span class="feas-metric" data-testid="metric-optimistic"><span class="feas-metric-label">Optimistic workload</span><strong>${formatMinutes(p.feasibility.optimistic_workload_minutes)}</strong></span>
                <span class="feas-metric" data-testid="metric-expected"><span class="feas-metric-label">Expected workload</span><strong>${formatMinutes(p.feasibility.expected_workload_minutes)}</strong></span>
                <span class="feas-metric" data-testid="metric-pessimistic"><span class="feas-metric-label">Pessimistic workload</span><strong>${formatMinutes(p.feasibility.pessimistic_workload_minutes)}</strong></span>
                <span class="feas-metric" data-testid="metric-optimistic-shortfall"><span class="feas-metric-label">Optimistic shortfall</span><strong>${formatMinutes(p.feasibility.optimistic_shortfall_minutes)}</strong></span>
                <span class="feas-metric" data-testid="metric-shortfall"><span class="feas-metric-label">Expected shortfall</span><strong>${formatMinutes(p.feasibility.expected_shortfall_minutes)}</strong></span>
                <span class="feas-metric" data-testid="metric-buffer"><span class="feas-metric-label">Deadline buffer</span><strong>${bufferDisplay}</strong></span>
            </div>
        </div>
        ${p.feasibility.warnings && p.feasibility.warnings.length ? `
            <div class="feas-warnings">
                <strong>Warnings</strong>
                <ul>${p.feasibility.warnings.map(w => `<li>${escapeHtml(displayWarning(w))}</li>`).join("")}</ul>
            </div>
        ` : ""}
    `;
    
    const schedContainer = document.getElementById("plan-schedule");
    const blocksByDate = {};
    [...p.scheduled_blocks]
        .sort((a, b) => new Date(a.start) - new Date(b.start))
        .forEach(b => {
        const d = new Date(b.start).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
        if (!blocksByDate[d]) blocksByDate[d] = [];
        blocksByDate[d].push(b);
    });
    
    if (Object.keys(blocksByDate).length === 0) {
        schedContainer.innerHTML = `<div class="empty-state">No tasks could be scheduled. Check your availability windows or deadline, then try again.</div>`;
    } else {
        schedContainer.innerHTML = Object.entries(blocksByDate).map(([date, blocks]) => `
            <div class="schedule-day" data-testid="schedule-day-${date}">
                <h4 class="day-title">${date}</h4>
                <div class="day-blocks">
                    ${blocks.map(b => {
                        const tStart = formatTime(b.start);
                        const tEnd = formatTime(b.end);
                        return `
                            <div class="sched-block" data-testid="schedule-block-${escapeHtml(b.task_id)}-${escapeHtml(b.start)}">
                                <div class="block-time"><time>${tStart}</time> - <time>${tEnd}</time></div>
                                <span class="timeline-node" aria-hidden="true"></span>
                                <div class="block-details">
                                    <div class="block-title">${escapeHtml(b.task_title)}</div>
                                    <div class="block-dur">${formatMinutes(b.scheduled_minutes)} block</div>
                                </div>
                            </div>
                        `;
                    }).join("")}
                </div>
            </div>
        `).join("");
    }
    
    const unfinContainer = document.getElementById("plan-unfinished");
    if (p.unfinished_tasks && p.unfinished_tasks.length > 0) {
        const unfinishedTasks = p.unfinished_tasks.map(taskId => {
            const task = state.analysis.tasks.find(candidate => candidate.task_id === taskId);
            return { taskId, task };
        });
        const hasOnlyOptionalUnfinished = unfinishedTasks.every(({ task }) => task && task.is_optional);
        unfinContainer.classList.remove("hidden");
        unfinContainer.classList.toggle("optional-only", hasOnlyOptionalUnfinished);
        document.getElementById("unfinished-kicker").textContent = hasOnlyOptionalUnfinished ? "Optional work" : "Needs attention";
        document.getElementById("unfinished-title").textContent = hasOnlyOptionalUnfinished ? "Optional work remaining" : "Unfinished tasks";
        document.getElementById("unfinished-description").textContent = hasOnlyOptionalUnfinished
            ? "These optional tasks could not be fully placed in the available time."
            : "These tasks could not be fully placed in the available time.";
        document.getElementById("unfinished-list").innerHTML = unfinishedTasks.map(({ taskId }) =>
            `<li>${escapeHtml(taskTitleForId(taskId))}</li>`
        ).join("");
    } else {
        unfinContainer.classList.add("hidden");
        unfinContainer.classList.remove("optional-only");
    }
}

function openReplanStage() {
    state.replanAvailability = JSON.parse(JSON.stringify(state.availability));
    renderAvailabilityList("replan-avail-list", state.replanAvailability, true);
    document.getElementById("replan-results").classList.add("hidden");
    hideError("replan-error");
    showStage("stage-replan");
}

document.getElementById("btn-edit-avail").addEventListener("click", openReplanStage);

// Stage 4: Replan
document.getElementById("btn-add-replan-avail").addEventListener("click", () => {
    const last = state.replanAvailability[state.replanAvailability.length - 1];
    state.replanAvailability.push({ 
        date: last ? last.date : "", 
        start: last ? last.start : "09:00", 
        end: last ? last.end : "17:00" 
    });
    renderAvailabilityList("replan-avail-list", state.replanAvailability, true);
});

document.getElementById("btn-cancel-replan").addEventListener("click", () => showStage("stage-plan"));

async function createReplanPreviewFromCurrentState(requestVersion = state.workflowVersion) {
    if (!state.analysis) {
        throw new Error("Coursework must be analyzed before a plan can be repaired.");
    }
    if (!state.plan) {
        throw new Error("An accepted execution plan is required before replanning.");
    }

    const payload = {
        analysis: state.analysis,
        previous_plan: state.plan,
        new_availability: state.replanAvailability.map(a => ({
            start: formatToIso(a.date, a.start),
            end: formatToIso(a.date, a.end)
        }))
    };
    
    document.getElementById("btn-execute-replan").disabled = true;
    document.getElementById("replan-loading").classList.remove("hidden");

    try {
        const res = await apiFetch("/api/replan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        
        let data;
        try {
            data = await res.json();
        } catch (e) {
            throw new Error("Invalid response from server.");
        }
        if (!res.ok) {
            throw new Error(responseError(
                res,
                data,
                "CourseFlow could not repair the plan. Check the updated availability and try again."
            ));
        }
        if (requestVersion !== state.workflowVersion) return null;

        state.replanResult = data;
        renderReplanResults();
        const affectedTasks = data.changes.filter(
            change => change.change_type !== "preserved"
        ).length;
        addActivity("Loaded the previous plan");
        addActivity(`Preserved ${data.preserved_block_count} valid block${data.preserved_block_count === 1 ? "" : "s"}`);
        addActivity(`Replanned ${affectedTasks} affected task${affectedTasks === 1 ? "" : "s"}`);
        addActivity(`Rechecked deadline risk: ${data.new_status.replace("_", " ")}`);
        return data;
    } finally {
        if (requestVersion === state.workflowVersion) {
            document.getElementById("btn-execute-replan").disabled = false;
            document.getElementById("replan-loading").classList.add("hidden");
        }
    }
}

document.getElementById("btn-execute-replan").addEventListener("click", async () => {
    const errorMsg = validateAvailability(state.replanAvailability);
    if (errorMsg) {
        showError("replan-error", errorMsg);
        return;
    }
    hideError("replan-error");
    const requestVersion = state.workflowVersion;

    try {
        await createReplanPreviewFromCurrentState(requestVersion);
    } catch (err) {
        if (requestVersion !== state.workflowVersion) return;
        showError(
            "replan-error",
            err.message || "CourseFlow could not repair the plan. Check the updated availability and try again."
        );
    }
});

function renderReplanResults() {
    const r = state.replanResult;
    const resultsContainer = document.getElementById("replan-results");
    resultsContainer.classList.remove("hidden");
    const feasibilityLabels = {
        comfortable: "Feasible",
        tight: "At Risk",
        at_risk: "At Risk",
        infeasible: "Infeasible",
    };
    
    const mandatoryTasks = (state.analysis && state.analysis.tasks) ? state.analysis.tasks.filter(t => !t.is_optional) : [];
    const prevHasUnfinishedMandatory = (state.plan && state.plan.unfinished_tasks) ? state.plan.unfinished_tasks.some(id =>
        mandatoryTasks.some(t => t.task_id === id)
    ) : false;
    const newHasUnfinishedMandatory = r.unfinished_tasks && r.unfinished_tasks.some(id =>
        mandatoryTasks.some(t => t.task_id === id)
    );

    const prevBufferDisplay = (prevHasUnfinishedMandatory || r.previous_status === 'infeasible')
        ? "N/A"
        : (r.previous_deadline_buffer_minutes !== null ? formatMinutes(r.previous_deadline_buffer_minutes) : "N/A");

    const newBufferDisplay = (newHasUnfinishedMandatory || r.new_status === 'infeasible')
        ? "N/A (unfinished)"
        : (r.new_deadline_buffer_minutes !== null ? formatMinutes(r.new_deadline_buffer_minutes) : "N/A");

    document.getElementById("replan-summary-metrics").innerHTML = `
        <div class="metric">
            <div class="metric-label">Feasibility transition</div>
            <div class="metric-val">
                <span class="status-badge status-${r.previous_status}">${feasibilityLabels[r.previous_status] || r.previous_status.replace(/_/g, " ")}</span>
                <span class="transition-arrow" aria-hidden="true">&rarr;</span>
                <span class="status-badge status-${r.new_status}">${feasibilityLabels[r.new_status] || r.new_status.replace(/_/g, " ")}</span>
            </div>
        </div>
        <div class="metric">
            <div class="metric-label">Preserved blocks</div>
            <div class="metric-val"><span class="metric-number">${r.preserved_block_count}</span><span class="metric-subtext">kept in place</span></div>
        </div>
        <div class="metric">
            <div class="metric-label">Changed blocks</div>
            <div class="metric-val"><span class="metric-number">${r.changed_block_count}</span><span class="metric-subtext">repaired</span></div>
        </div>
        <div class="metric">
            <div class="metric-label">Deadline impact</div>
            <div class="metric-val"><span>${prevBufferDisplay}</span><span class="transition-arrow" aria-hidden="true">&rarr;</span><span>${newBufferDisplay}</span></div>
        </div>
    `;
    
    const changesContainer = document.getElementById("replan-changes");
    if (r.changes && r.changes.length) {
        const chronologicalChanges = r.changes
            .map((change, originalIndex) => ({ change, originalIndex }))
            .sort((a, b) => {
                const previousStart = ({ change }) => {
                    const starts = change.old_blocks
                        .map(block => new Date(block.start).getTime())
                        .filter(Number.isFinite);
                    return starts.length ? Math.min(...starts) : Infinity;
                };
                return previousStart(a) - previousStart(b) || a.originalIndex - b.originalIndex;
            })
            .map(({ change }) => change);
        changesContainer.innerHTML = chronologicalChanges.map(c => `
            <div class="change-card change-${c.change_type}" data-testid="change-card-${escapeHtml(c.task_id)}">
                <div class="change-header">
                    <strong>${escapeHtml(c.task_title)}</strong>
                    <span class="change-badge type-${c.change_type}">${escapeHtml(c.change_type.replace(/_/g, " "))}</span>
                </div>
                <div class="change-reason">${escapeHtml(c.reason)}</div>
                ${c.old_blocks.length || c.new_blocks.length ? `
                    <div class="change-times">
                        <div class="change-col">
                            <div class="col-title">Previous</div>
                            ${c.old_blocks.length ? c.old_blocks.map(b => `<div>${formatDate(b.start)} ${formatTime(b.start)}-${formatTime(b.end)}</div>`).join("") : "<div>None</div>"}
                        </div>
                        <div class="change-arrow" aria-hidden="true">&rarr;</div>
                        <div class="change-col is-new">
                            <div class="col-title">New</div>
                            ${c.new_blocks.length ? c.new_blocks.map(b => `<div>${formatDate(b.start)} ${formatTime(b.start)}-${formatTime(b.end)}</div>`).join("") : "<div>None</div>"}
                        </div>
                    </div>
                ` : ""}
            </div>
        `).join("");
    } else {
        changesContainer.innerHTML = `<div class="empty-state">No changes to the schedule.</div>`;
    }
}

document.getElementById("btn-accept-replan").addEventListener("click", () => {
    state.availability = JSON.parse(JSON.stringify(state.replanAvailability));
    // The replan result implements PlanResult so we can just use it as the new plan state
    state.plan = state.replanResult;
    renderPlan();
    showStage("stage-plan");
});

function courseworkAnalysisForAgent() {
    const analysis = state.analysis;
    if (!analysis) {
        return {
            status: "not_ready",
            message: "No coursework has been analyzed yet. The human must upload and analyze a PDF first.",
        };
    }

    const sourcedRequirements = Array.isArray(analysis.requirement_evidence)
        ? analysis.requirement_evidence
        : [];
    const tasks = Array.isArray(analysis.tasks) ? analysis.tasks : [];

    return {
        status: "ready",
        assignment: {
            title: analysis.title,
            deadline: analysis.deadline || null,
            deadline_iso: analysis.deadline_iso || null,
        },
        deliverables: Array.isArray(analysis.deliverable_evidence) && analysis.deliverable_evidence.length
            ? analysis.deliverable_evidence.map(item => item.fact)
            : (Array.isArray(analysis.deliverables) ? analysis.deliverables : []),
        requirements: {
            mandatory: sourcedRequirements.length
                ? sourcedRequirements.filter(item => !item.is_optional).map(item => item.fact)
                : (Array.isArray(analysis.requirements) ? analysis.requirements : []),
            optional: sourcedRequirements
                .filter(item => item.is_optional)
                .map(item => item.fact),
        },
        tasks: tasks.map(task => ({
            task_id: task.task_id || null,
            title: task.title,
            description: task.description,
            source_requirement: task.source_requirement,
            dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
            is_optional: Boolean(task.is_optional),
            workload_estimate_minutes: {
                optimistic: task.optimistic_minutes,
                expected: task.expected_minutes,
                pessimistic: task.pessimistic_minutes,
                confidence: task.confidence,
            },
        })),
        ambiguities: Array.isArray(analysis.ambiguities) ? analysis.ambiguities : [],
        warnings: Array.isArray(analysis.warnings) ? analysis.warnings : [],
    };
}

function parseAgentAvailabilityDateTime(value, label) {
    if (typeof value !== "string") {
        throw new Error(`${label} must be an ISO date-time string.`);
    }

    const trimmed = value.trim();
    const match = trimmed.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/
    );
    if (!match) {
        throw new Error(`${label} must be a timezone-aware ISO date-time.`);
    }

    const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0", fractionText = ""] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

    if (
        wallClock.getUTCFullYear() !== year ||
        wallClock.getUTCMonth() !== month - 1 ||
        wallClock.getUTCDate() !== day ||
        wallClock.getUTCHours() !== hour ||
        wallClock.getUTCMinutes() !== minute ||
        wallClock.getUTCSeconds() !== second
    ) {
        throw new Error(`${label} contains an invalid calendar date or time.`);
    }
    if (second !== 0 || /[1-9]/.test(fractionText)) {
        throw new Error(`${label} must be aligned to a whole minute.`);
    }

    const instantMilliseconds = Date.parse(trimmed);
    if (!Number.isFinite(instantMilliseconds)) {
        throw new Error(`${label} is not a valid ISO date-time.`);
    }

    return {
        instantMilliseconds,
        date: `${yearText}-${monthText}-${dayText}`,
        time: `${hourText}:${minuteText}`,
    };
}

function normalizeAgentAvailabilityWindows(windows) {
    if (!Array.isArray(windows) || windows.length === 0) {
        throw new Error("At least one availability window is required.");
    }

    const rows = [];
    const normalizedWindows = [];
    const normalizedIntervals = [];

    windows.forEach((window, index) => {
        if (!window || typeof window !== "object" || Array.isArray(window)) {
            throw new Error(`Window ${index + 1} must be an object with start and end.`);
        }

        const start = parseAgentAvailabilityDateTime(window.start, `Window ${index + 1} start`);
        const end = parseAgentAvailabilityDateTime(window.end, `Window ${index + 1} end`);
        if (end.instantMilliseconds <= start.instantMilliseconds) {
            throw new Error(`Window ${index + 1} end must occur after its start.`);
        }
        if (start.date !== end.date) {
            throw new Error(`Window ${index + 1} must start and end on the same local date.`);
        }

        const row = { date: start.date, start: start.time, end: end.time };
        const rowError = validateAvailability([row]);
        if (rowError) {
            throw new Error(`Window ${index + 1}: ${rowError.replace(/^Row 1:\s*/, "")}`);
        }

        const normalizedStart = formatToIso(row.date, row.start);
        const normalizedEnd = formatToIso(row.date, row.end);
        const normalizedStartMilliseconds = new Date(normalizedStart).getTime();
        const normalizedEndMilliseconds = new Date(normalizedEnd).getTime();
        const durationMinutes = (normalizedEndMilliseconds - normalizedStartMilliseconds) / 60000;
        rows.push(row);
        normalizedIntervals.push({
            start: normalizedStartMilliseconds,
            end: normalizedEndMilliseconds,
        });
        normalizedWindows.push({
            start: normalizedStart,
            end: normalizedEnd,
            local_date: row.date,
            local_start: row.start,
            local_end: row.end,
            duration_minutes: durationMinutes,
        });
    });

    normalizedIntervals.sort((a, b) => a.start - b.start);
    let totalAvailableMinutes = 0;
    let mergedEnd = null;
    for (const interval of normalizedIntervals) {
        if (mergedEnd === null || interval.start > mergedEnd) {
            totalAvailableMinutes += (interval.end - interval.start) / 60000;
            mergedEnd = interval.end;
        } else if (interval.end > mergedEnd) {
            totalAvailableMinutes += (interval.end - mergedEnd) / 60000;
            mergedEnd = interval.end;
        }
    }

    return { rows, normalizedWindows, totalAvailableMinutes };
}

function setAvailabilityForAgent(windows) {
    let normalized;
    try {
        normalized = normalizeAgentAvailabilityWindows(windows);
    } catch (error) {
        return {
            status: "invalid_availability",
            availability_unchanged: true,
            message: error.message || "The availability windows are invalid.",
        };
    }

    const replacedStalePlan = Boolean(state.plan || state.replanResult);
    state.availability = normalized.rows.map(row => ({ ...row }));
    invalidatePlanAfterAvailabilityChange();
    renderAvailabilityList("avail-list", state.availability, false);
    hideError("avail-error");
    if (state.analysis) showStage("stage-availability");

    return {
        status: "updated",
        availability: normalized.normalizedWindows,
        total_available_minutes: normalized.totalAvailableMinutes,
        message: `Set ${state.availability.length} availability window${state.availability.length === 1 ? "" : "s"} in CourseFlow${replacedStalePlan ? " and cleared the stale plan" : ""}.`,
    };
}

function unfinishedMandatoryWorkForAgent(taskIds) {
    const tasks = state.analysis && Array.isArray(state.analysis.tasks)
        ? state.analysis.tasks
        : [];
    const mandatoryTasks = new Map(
        tasks.filter(task => !task.is_optional).map(task => [task.task_id, task])
    );
    return (Array.isArray(taskIds) ? taskIds : [])
        .filter(taskId => mandatoryTasks.has(taskId))
        .map(taskId => ({
            task_id: taskId,
            title: mandatoryTasks.get(taskId).title,
        }));
}

function executionPlanForAgent(plan) {
    return {
        status: "created",
        feasibility: {
            status: plan.feasibility.status,
            available_minutes: plan.feasibility.available_minutes,
            optimistic_workload_minutes: plan.feasibility.optimistic_workload_minutes,
            expected_workload_minutes: plan.feasibility.expected_workload_minutes,
            pessimistic_workload_minutes: plan.feasibility.pessimistic_workload_minutes,
        },
        deadline: {
            coursework_deadline: state.analysis.deadline_iso || state.analysis.deadline || null,
            buffer_minutes: plan.deadline_buffer_minutes,
        },
        warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
        unfinished_mandatory_work: unfinishedMandatoryWorkForAgent(plan.unfinished_tasks),
        scheduled_blocks: (Array.isArray(plan.scheduled_blocks) ? plan.scheduled_blocks : []).map(block => ({
            task_id: block.task_id,
            task_title: block.task_title,
            start: block.start,
            end: block.end,
            scheduled_minutes: block.scheduled_minutes,
        })),
        message: `Created and displayed a ${plan.feasibility.status.replace(/_/g, " ")} execution plan in CourseFlow.`,
    };
}

async function createExecutionPlanForAgent() {
    if (!state.analysis) {
        return {
            status: "not_ready",
            message: "No coursework has been analyzed yet. The human must upload and analyze a PDF first.",
        };
    }

    const availabilityError = validateAvailability(state.availability);
    if (availabilityError) {
        showError("avail-error", availabilityError);
        showStage("stage-availability");
        return {
            status: "invalid_availability",
            message: availabilityError,
        };
    }

    hideError("avail-error");
    const requestVersion = state.workflowVersion;
    try {
        const plan = await createExecutionPlanFromCurrentState(requestVersion);
        if (!plan) {
            return {
                status: "cancelled",
                message: "Plan creation was cancelled because the CourseFlow workflow changed.",
            };
        }
        return executionPlanForAgent(plan);
    } catch (error) {
        const message = error.message || "CourseFlow could not build the execution plan.";
        if (requestVersion === state.workflowVersion) showError("avail-error", message);
        return {
            status: "error",
            message,
        };
    }
}

function replanPreviewForAgent(result) {
    return {
        status: "preview_ready",
        feasibility: {
            previous_status: result.previous_status,
            new_status: result.new_status,
        },
        availability: {
            previous_total_minutes: state.plan.feasibility.available_minutes,
            proposed_total_minutes: result.feasibility.available_minutes,
        },
        schedule_changes: {
            preserved_block_count: result.preserved_block_count,
            changed_block_count: result.changed_block_count,
        },
        deadline: {
            previous_buffer_minutes: result.previous_deadline_buffer_minutes,
            new_buffer_minutes: result.new_deadline_buffer_minutes,
        },
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        unfinished_mandatory_work: unfinishedMandatoryWorkForAgent(result.unfinished_tasks),
        changes: (Array.isArray(result.changes) ? result.changes : []).map(change => ({
            task_id: change.task_id,
            task_title: change.task_title,
            change_type: change.change_type,
            reason: change.reason,
        })),
        awaiting_human_acceptance: true,
        message: "Created and displayed a replan preview in CourseFlow. The accepted availability and plan are unchanged until the human reviews and accepts this preview.",
    };
}

async function replanCourseworkForAgent(windows) {
    if (!state.analysis) {
        return {
            status: "not_ready",
            message: "No coursework has been analyzed yet. The human must upload and analyze a PDF first.",
        };
    }
    if (!state.plan) {
        return {
            status: "not_ready",
            message: "No accepted execution plan exists yet. Run create_execution_plan before requesting a replan preview.",
        };
    }

    let normalized;
    try {
        normalized = normalizeAgentAvailabilityWindows(windows);
    } catch (error) {
        return {
            status: "invalid_availability",
            availability_unchanged: true,
            plan_unchanged: true,
            message: error.message || "The proposed availability windows are invalid.",
        };
    }

    const previousPreviewAvailability = JSON.parse(JSON.stringify(state.replanAvailability));
    const previousPreviewResult = state.replanResult;
    state.replanAvailability = normalized.rows.map(row => ({ ...row }));
    state.replanResult = null;
    renderAvailabilityList("replan-avail-list", state.replanAvailability, true);
    document.getElementById("replan-results").classList.add("hidden");
    hideError("replan-error");
    showStage("stage-replan");

    const requestVersion = state.workflowVersion;
    try {
        const result = await createReplanPreviewFromCurrentState(requestVersion);
        if (!result) {
            return {
                status: "cancelled",
                message: "Replanning was cancelled because the CourseFlow workflow changed.",
            };
        }
        return replanPreviewForAgent(result);
    } catch (error) {
        const message = error.message || "CourseFlow could not create the replan preview.";
        if (requestVersion === state.workflowVersion) {
            state.replanAvailability = previousPreviewAvailability;
            state.replanResult = previousPreviewResult;
            renderAvailabilityList("replan-avail-list", state.replanAvailability, true);
            if (state.replanResult) {
                renderReplanResults();
            } else {
                document.getElementById("replan-results").classList.add("hidden");
            }
            showError("replan-error", message);
            showStage("stage-replan");
        }
        return {
            status: "error",
            availability_unchanged: true,
            plan_unchanged: true,
            message,
        };
    }
}

async function registerCourseFlowWebMcpTool(definition) {
    try {
        await document.modelContext.registerTool(definition);
    } catch (error) {
        console.warn(`[CourseFlow WebMCP] Could not register ${definition.name}.`, error);
    }
}

async function registerCourseFlowWebMcpTools() {
    if (typeof document.modelContext?.registerTool !== "function") {
        return;
    }

    await registerCourseFlowWebMcpTool({
        name: "get_coursework_analysis",
        description: "Inspect the coursework analysis currently loaded by the human in CourseFlow. Call this after the human analyzes a PDF and before helping with requirements, workload, or planning.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
        annotations: {
            readOnlyHint: true,
        },
        execute: async () => courseworkAnalysisForAgent(),
    });

    await registerCourseFlowWebMcpTool({
        name: "set_availability",
        description: "Replace the student's availability windows visible in CourseFlow. Call this after coursework analysis and before creating a plan; it updates the Availability UI and clears any stale plan without generating a new one.",
        inputSchema: {
            type: "object",
            properties: {
                windows: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: {
                            start: {
                                type: "string",
                                format: "date-time",
                                description: "Timezone-aware ISO date-time for the start of a same-day, minute-aligned availability window.",
                            },
                            end: {
                                type: "string",
                                format: "date-time",
                                description: "Timezone-aware ISO date-time after start for the end of the same-day, minute-aligned window.",
                            },
                        },
                        required: ["start", "end"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["windows"],
            additionalProperties: false,
        },
        execute: async (input = {}) => setAvailabilityForAgent(input.windows),
    });

    await registerCourseFlowWebMcpTool({
        name: "create_execution_plan",
        description: "Generate and display the real CourseFlow execution plan using the current coursework analysis and visible availability. Call this only after coursework has been analyzed and valid availability has been set; it invokes the existing planner API and updates the Plan UI.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
        execute: async () => createExecutionPlanForAgent(),
    });

    await registerCourseFlowWebMcpTool({
        name: "replan_coursework",
        description: "Propose replacement availability and generate a CourseFlow replan preview for an existing accepted execution plan. This updates the Replan review UI but does not change the active availability or plan until the human explicitly accepts the preview.",
        inputSchema: {
            type: "object",
            properties: {
                windows: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: {
                            start: {
                                type: "string",
                                format: "date-time",
                                description: "Timezone-aware ISO date-time for the start of a same-day, minute-aligned proposed availability window.",
                            },
                            end: {
                                type: "string",
                                format: "date-time",
                                description: "Timezone-aware ISO date-time after start for the end of the same-day, minute-aligned proposed window.",
                            },
                        },
                        required: ["start", "end"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["windows"],
            additionalProperties: false,
        },
        execute: async (input = {}) => replanCourseworkForAgent(input.windows),
    });
}

void registerCourseFlowWebMcpTools();
