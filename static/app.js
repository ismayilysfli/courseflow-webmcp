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
        document.getElementById(n).classList.remove("active");
    });
    
    if (stageId === "stage-documents") document.getElementById("nav-step-docs").classList.add("active");
    if (stageId === "stage-availability") document.getElementById("nav-step-avail").classList.add("active");
    if (stageId === "stage-plan") document.getElementById("nav-step-plan").classList.add("active");
    if (stageId === "stage-replan") document.getElementById("nav-step-replan").classList.add("active");
}

function updateNavigationAccess() {
    document.getElementById("nav-step-avail").disabled = !state.analysis;
    document.getElementById("nav-step-plan").disabled = !state.plan;
    document.getElementById("nav-step-replan").disabled = !state.plan;
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
    dropArea.addEventListener(eventName, () => dropArea.style.borderColor = "var(--accent-color)");
});
['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, () => dropArea.style.borderColor = "var(--border-color)");
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
            <span>${escapeHtml(f.name)} <span style="color:var(--text-secondary);font-size:0.85rem">(${formatBytes(f.size)})</span></span>
            <button type="button" class="button button-danger-icon btn-remove-pdf" aria-label="Remove" data-index="${i}" data-testid="remove-file-${i}">&times;</button>
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
                <summary>Source: ${escapeHtml(e.source_file)} ${e.page_number ? `(Page ${e.page_number})` : ""}</summary>
                <div class="evidence-snippet">${escapeHtml(e.source_snippet)}</div>
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
            <div class="fact-text">${escapeHtml(d.fact)}</div>
            ${renderEvidences(d.evidence)}
        </li>`).join("");
    } else {
        delContainer.innerHTML = `<li class="empty-state">No deliverables extracted.</li>`;
    }

    const reqContainer = document.getElementById("analysis-requirements");
    if (data.requirement_evidence && data.requirement_evidence.length) {
        reqContainer.innerHTML = data.requirement_evidence.map((r, index) => `<li data-testid="requirement-${index}">
            <div class="fact-text" style="display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem;">
                <span>${escapeHtml(r.fact)}</span>
                ${r.is_optional ? `<span class="badge badge-optional" data-testid="badge-optional-req-${index}">Optional</span>` : ""}
            </div>
            ${renderEvidences(r.evidence)}
        </li>`).join("");
    } else {
        reqContainer.innerHTML = `<li class="empty-state">No specific requirements extracted.</li>`;
    }
    
    const ambContainer = document.getElementById("analysis-ambiguities");
    if (data.ambiguities && data.ambiguities.length) {
        ambContainer.innerHTML = data.ambiguities.map(
            (a, index) => `<li data-testid="ambiguity-${index}">${escapeHtml(a)}</li>`
        ).join("");
    } else {
        ambContainer.innerHTML = `<li class="empty-state">No ambiguities found.</li>`;
    }
    
    const taskContainer = document.getElementById("analysis-tasks");
    taskContainer.innerHTML = data.tasks.map(t => `
        <div class="task-card" data-testid="task-card-${escapeHtml(t.task_id)}">
            <div class="task-card-header">
                <h5>${escapeHtml(t.title)}</h5>
                ${t.is_optional ? `<span class="badge badge-optional" data-testid="badge-optional-${escapeHtml(t.task_id)}">Optional</span>` : ""}
            </div>
            <p class="task-desc">${escapeHtml(t.description)}</p>
            <div class="task-meta">
                <span class="conf-badge conf-${t.confidence}">Confidence: ${t.confidence}</span>
                <span class="est-times">Opt: ${formatMinutes(t.optimistic_minutes)} / Exp: ${formatMinutes(t.expected_minutes)} / Pess: ${formatMinutes(t.pessimistic_minutes)}</span>
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

function renderAvailabilityList(containerId, dataArray, isReplan = false) {
    const container = document.getElementById(containerId);
    container.innerHTML = dataArray.map((avail, index) => `
        <div class="avail-row" data-index="${index}">
            <div class="avail-group">
                <label>Date</label>
                <input type="date" class="avail-date input-field" value="${escapeHtml(avail.date)}" data-testid="input-avail-date-${index}">
            </div>
            <div class="avail-group">
                <label>Start Time</label>
                <input type="time" class="avail-start input-field" value="${escapeHtml(avail.start)}" data-testid="input-avail-start-${index}">
            </div>
            <div class="avail-group">
                <label>End Time</label>
                <input type="time" class="avail-end input-field" value="${escapeHtml(avail.end)}" data-testid="input-avail-end-${index}">
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

document.getElementById("btn-generate-plan").addEventListener("click", async () => {
    const errorMsg = validateAvailability(state.availability);
    if (errorMsg) {
        showError("avail-error", errorMsg);
        return;
    }
    hideError("avail-error");
    const requestVersion = state.workflowVersion;
    
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
        if (requestVersion !== state.workflowVersion) return;
        
        state.plan = data;
        renderPlan();
        updateNavigationAccess();
        addActivity(`Checked schedule feasibility: ${data.feasibility.status.replace("_", " ")}`);
        addActivity(`Built an execution plan with ${data.scheduled_blocks.length} scheduled block${data.scheduled_blocks.length === 1 ? "" : "s"}`);
        showStage("stage-plan");
    } catch (err) {
        if (requestVersion !== state.workflowVersion) return;
        showError(
            "avail-error",
            err.message || "CourseFlow could not build the plan. Check your availability and try again."
        );
    } finally {
        if (requestVersion === state.workflowVersion) {
            document.getElementById("btn-generate-plan").disabled = false;
            document.getElementById("plan-loading").classList.add("hidden");
        }
    }
});

// Stage 3: Plan
function renderPlan() {
    const p = state.plan;
    const feasCard = document.getElementById("plan-feasibility");
    
    const mandatoryTasks = (state.analysis && state.analysis.tasks) ? state.analysis.tasks.filter(t => !t.is_optional) : [];
    const hasUnfinishedMandatory = p.unfinished_tasks && p.unfinished_tasks.some(id =>
        mandatoryTasks.some(t => t.task_id === id)
    );
    let bufferDisplay;
    if (hasUnfinishedMandatory || p.feasibility.status === 'infeasible') {
        bufferDisplay = "N/A — mandatory work remains unfinished";
    } else if (p.deadline_buffer_minutes !== null) {
        bufferDisplay = formatMinutes(p.deadline_buffer_minutes);
    } else {
        bufferDisplay = "Not available";
    }

    feasCard.className = `feasibility-card status-${p.feasibility.status}`;
    feasCard.innerHTML = `
        <div class="feas-header">
            <h3>Feasibility: <span class="status-label">${p.feasibility.status.replace("_", " ")}</span></h3>
            <div class="feas-metrics">
                <span data-testid="metric-available">Available time: <strong>${formatMinutes(p.feasibility.available_minutes)}</strong></span>
                <span data-testid="metric-optimistic">Optimistic workload: <strong>${formatMinutes(p.feasibility.optimistic_workload_minutes)}</strong></span>
                <span data-testid="metric-expected">Expected workload: <strong>${formatMinutes(p.feasibility.expected_workload_minutes)}</strong></span>
                <span data-testid="metric-pessimistic">Pessimistic workload: <strong>${formatMinutes(p.feasibility.pessimistic_workload_minutes)}</strong></span>
                <span data-testid="metric-optimistic-shortfall">Optimistic shortfall: <strong>${formatMinutes(p.feasibility.optimistic_shortfall_minutes)}</strong></span>
                <span data-testid="metric-shortfall">Expected shortfall: <strong>${formatMinutes(p.feasibility.expected_shortfall_minutes)}</strong></span>
                <span data-testid="metric-buffer">Deadline buffer: <strong>${bufferDisplay}</strong></span>
            </div>
        </div>
        ${p.feasibility.warnings && p.feasibility.warnings.length ? `
            <div class="feas-warnings">
                <strong>Warnings</strong>
                <ul>${p.feasibility.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
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
        schedContainer.innerHTML = `<div class="empty-state" style="padding: 2rem; background: var(--surface); border: 1px solid var(--border-color); border-radius: var(--radius);">No tasks scheduled. Check your availability constraints or deadline.</div>`;
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
                                <div class="block-time">${tStart} - ${tEnd}</div>
                                <div class="block-details">
                                    <div class="block-title">${escapeHtml(b.task_title)}</div>
                                    <div class="block-dur">${formatMinutes(b.scheduled_minutes)}</div>
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
        unfinContainer.classList.remove("hidden");
        document.getElementById("unfinished-list").innerHTML = p.unfinished_tasks.map(t => {
            const task = state.analysis.tasks.find(tk => tk.task_id === t);
            return `<li>${escapeHtml(task ? task.title : t)}</li>`;
        }).join("");
    } else {
        unfinContainer.classList.add("hidden");
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

document.getElementById("btn-execute-replan").addEventListener("click", async () => {
    const errorMsg = validateAvailability(state.replanAvailability);
    if (errorMsg) {
        showError("replan-error", errorMsg);
        return;
    }
    hideError("replan-error");
    const requestVersion = state.workflowVersion;
    
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
        if (requestVersion !== state.workflowVersion) return;
        
        state.replanResult = data;
        renderReplanResults();
        const affectedTasks = data.changes.filter(
            change => change.change_type !== "preserved"
        ).length;
        addActivity("Loaded the previous plan");
        addActivity(`Preserved ${data.preserved_block_count} valid block${data.preserved_block_count === 1 ? "" : "s"}`);
        addActivity(`Replanned ${affectedTasks} affected task${affectedTasks === 1 ? "" : "s"}`);
        addActivity(`Rechecked deadline risk: ${data.new_status.replace("_", " ")}`);
    } catch (err) {
        if (requestVersion !== state.workflowVersion) return;
        showError(
            "replan-error",
            err.message || "CourseFlow could not repair the plan. Check the updated availability and try again."
        );
    } finally {
        if (requestVersion === state.workflowVersion) {
            document.getElementById("btn-execute-replan").disabled = false;
            document.getElementById("replan-loading").classList.add("hidden");
        }
    }
});

function renderReplanResults() {
    const r = state.replanResult;
    const resultsContainer = document.getElementById("replan-results");
    resultsContainer.classList.remove("hidden");
    
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
            <div class="metric-label">Feasibility</div>
            <div class="metric-val">
                <span class="status-badge conf-${r.previous_status}">${r.previous_status.replace("_", " ")}</span>
                &rarr;
                <span class="status-badge conf-${r.new_status}">${r.new_status.replace("_", " ")}</span>
            </div>
        </div>
        <div class="metric">
            <div class="metric-label">Buffer</div>
            <div class="metric-val">
                ${prevBufferDisplay}
                &rarr;
                ${newBufferDisplay}
            </div>
        </div>
        <div class="metric">
            <div class="metric-label">Impact</div>
            <div class="metric-val">${r.changed_block_count} blocks changed (${r.preserved_block_count} preserved)</div>
        </div>
    `;
    
    const changesContainer = document.getElementById("replan-changes");
    if (r.changes && r.changes.length) {
        changesContainer.innerHTML = r.changes.map(c => `
            <div class="change-card" data-testid="change-card-${escapeHtml(c.task_id)}">
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
                        <div class="change-col">
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
