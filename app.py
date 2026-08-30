import os

from dotenv import load_dotenv
from werkzeug.exceptions import RequestEntityTooLarge

from agent.course_agent import (
    SourceReferenceError,
    analyze_assignment,
    analyze_assignment_pages,
    validate_source_references,
)
from flask import Flask, jsonify, render_template, request
from pydantic import ValidationError

from services.document_service import (
    DocumentProcessingError,
    extract_pdf_pages,
    format_page_blocks,
)
from services.planner import PlannerError, build_plan, normalize_analysis
from services.replanner import replan
from models.schemas import PlanRequest, ReplanRequest

load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024


@app.get("/")
def home():
    return render_template("index.html")


@app.errorhandler(RequestEntityTooLarge)
def request_too_large(_error):
    return jsonify({"error": "The combined PDF upload exceeds the 20 MB limit."}), 413


@app.post("/api/analyze")
def analyze():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
        return jsonify({"error": 'Request body must be JSON with a "text" string.'}), 400

    assignment_text = payload["text"].strip()
    if not assignment_text:
        return jsonify({"error": 'The "text" field cannot be empty.'}), 400

    if not os.environ.get("GOOGLE_API_KEY"):
        return (
            jsonify(
                {
                    "error": (
                        "GOOGLE_API_KEY is not configured. Add it to the environment "
                        "before running assignment analysis."
                    )
                }
            ),
            503,
        )

    try:
        analysis = normalize_analysis(analyze_assignment(assignment_text))
    except Exception:
        app.logger.exception("Assignment analysis failed")
        return (
            jsonify(
                {
                    "error": (
                        "The assignment could not be analyzed. "
                        "Please try again or check the Gemini configuration."
                    )
                }
            ),
            502,
        )

    return jsonify(analysis.model_dump(mode="json"))


@app.post("/api/analyze-pdf")
def analyze_pdf():
    try:
        pages = extract_pdf_pages(request.files.getlist("files"))
    except DocumentProcessingError as error:
        return jsonify({"error": str(error)}), 400

    if not os.environ.get("GOOGLE_API_KEY"):
        return (
            jsonify(
                {
                    "error": (
                        "GOOGLE_API_KEY is not configured. Add it to the environment "
                        "before running assignment analysis."
                    )
                }
            ),
            503,
        )

    try:
        analysis = normalize_analysis(
            analyze_assignment_pages(format_page_blocks(pages))
        )
        available_pages: dict[str, set[int]] = {}
        for page in pages:
            available_pages.setdefault(page.source_file, set()).add(page.page_number)
        validate_source_references(analysis, available_pages)
    except SourceReferenceError:
        app.logger.exception("PDF source reference validation failed")
        return (
            jsonify(
                {
                    "error": (
                        "Gemini returned an invalid source reference for the "
                        "uploaded PDFs."
                    )
                }
            ),
            502,
        )
    except ValidationError:
        app.logger.exception("PDF analysis schema validation failed")
        return (
            jsonify(
                {
                    "error": (
                        "Gemini returned data that failed AssignmentAnalysis "
                        "validation."
                    )
                }
            ),
            502,
        )
    except Exception:
        app.logger.exception("PDF assignment analysis failed")
        return (
            jsonify(
                {
                    "error": (
                        "The PDF assignment could not be analyzed. "
                        "Please try again or check the Gemini configuration."
                    )
                }
            ),
            502,
        )

    return jsonify(analysis.model_dump(mode="json"))


@app.post("/api/plan")
def plan():
    payload = request.get_json(silent=True)
    try:
        plan_request = PlanRequest.model_validate(payload)
        result = build_plan(
            plan_request.analysis,
            plan_request.availability,
        )
    except ValidationError:
        return (
            jsonify(
                {
                    "error": (
                        "Request body must contain a valid AssignmentAnalysis "
                        "and timezone-aware availability windows."
                    )
                }
            ),
            400,
        )
    except PlannerError as error:
        return jsonify({"error": str(error)}), 400

    return jsonify(result.model_dump(mode="json"))


@app.post("/api/replan")
def replan_existing():
    payload = request.get_json(silent=True)
    try:
        replan_request = ReplanRequest.model_validate(payload)
        result = replan(
            replan_request.analysis,
            replan_request.previous_plan,
            replan_request.new_availability,
        )
    except ValidationError:
        return (
            jsonify(
                {
                    "error": (
                        "Request body must contain a valid AssignmentAnalysis, "
                        "previous plan, and timezone-aware new availability."
                    )
                }
            ),
            400,
        )
    except PlannerError as error:
        return jsonify({"error": str(error)}), 400

    return jsonify(result.model_dump(mode="json"))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
