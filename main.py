import html
import io
import json
import os
import re
import tempfile
import unicodedata
from typing import List, Optional

import pdfplumber
import requests
from docx import Document
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
from starlette.background import BackgroundTask

app = FastAPI(title="PaperTrace API", version="0.2.0")

# Restrict CORS to local development origins. Add your deployed frontend URL here later.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/generate")
MODEL_NAME = os.getenv("OLLAMA_MODEL", "llama3.2")
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_TEXT_CHARS = 16000
MAX_REVIEW_ITEMS = 8
MAX_AI_QUESTIONS = 20
MAX_MODEL_NODES_TO_CHECK = 60


def clean_text(text: str) -> str:
    cleaned_lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if re.match(r"^(page\s+\d+(\s+of\s+\d+)?|\d+)$", stripped, re.IGNORECASE):
            continue
        if len(stripped) > 1:
            cleaned_lines.append(stripped)
    return "\n".join(cleaned_lines)


def extract_json_from_response(content: str) -> dict:
    """Parse strict JSON first, then tolerate a JSON object wrapped in code fences."""
    try:
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        pass

    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL | re.IGNORECASE)
    if match:
        try:
            parsed = json.loads(match.group(1))
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            pass

    # Some local models add a short preamble. Only accept the outermost JSON object if valid.
    start = content.find("{")
    end = content.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(content[start : end + 1])
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            pass
    return {}


QUESTION_STOP_WORDS = {
    "a", "about", "above", "after", "again", "all", "also", "am", "an", "and", "any", "are",
    "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but",
    "by", "can", "could", "did", "do", "does", "doing", "down", "during", "each", "few", "for",
    "from", "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself",
    "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just",
    "me", "might", "more", "most", "must", "my", "myself", "no", "nor", "not", "now", "of", "off",
    "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own", "please",
    "same", "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them",
    "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under",
    "until", "up", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who",
    "whom", "why", "will", "with", "would", "you", "your", "yours", "yourself", "yourselves", "us",
    "our", "document", "documents", "source", "excerpt", "instruction", "instructions", "requirement",
    "requirements", "criterion", "criteria", "rule", "rules", "guideline", "guidelines", "question", "item",
    "check", "checking", "confirm", "confirming", "ensure", "ensuring", "meet", "meeting", "satisfy",
    "satisfies", "satisfied", "compliant", "compliance", "ready", "prepared", "verified", "understand",
    "understood", "clear", "clarification", "everything", "overall", "complete", "completed", "applicable", "program", "programs",
    "apply", "applies", "relevant", "relevance", "following", "above", "below", "listed", "stated", "specified",
}

GENERIC_QUESTION_PATTERNS = [
    re.compile(r"^how clear is this instruction(?: to you)?$", re.IGNORECASE),
    re.compile(r"^do you understand (?:this|the) instruction$", re.IGNORECASE),
    re.compile(r"^(?:have you|did you) prepared and verified this requirement$", re.IGNORECASE),
    re.compile(r"^(?:have you|did you) (?:checked|verified|reviewed|prepared) (?:all|the|this) (?:requirements?|rules?|criteria|guidelines?|instructions?)$", re.IGNORECASE),
    re.compile(r"^(?:have you|did you|do you|does your .{1,35}?)\b.*\b(?:all (?:the )?)?(?:requirements?|criteria|guidelines?|conditions?)\b", re.IGNORECASE),
    re.compile(r"^(?:are|is) (?:all )?(?:the )?(?:requirements?|criteria|conditions?|rules?|guidelines?) (?:met|satisfied|fulfilled|complete|completed)$", re.IGNORECASE),
    re.compile(r"^(?:is everything|are you) (?:ready|complete|in order|prepared)$", re.IGNORECASE),
    re.compile(r"^(?:are you compliant|does this document meet all requirements)$", re.IGNORECASE),
]


def normalize_source_for_match(value: str) -> str:
    """Normalize whitespace, Unicode composition, and casing without changing wording or punctuation."""
    normalized = unicodedata.normalize("NFC", str(value or "")).replace("\u00ad", "")
    return re.sub(r"\s+", " ", normalized).strip().casefold()


def _content_words(value: str) -> set[str]:
    """Return lightweight content tokens for a conservative question/source relevance check."""
    words = re.findall(r"[^\W_]+", unicodedata.normalize("NFC", str(value or "")).casefold(), re.UNICODE)
    result = set()
    for word in words:
        if word in QUESTION_STOP_WORDS:
            continue
        # Normalize ordinary plurals without applying aggressive stemming to legal terms,
        # dates, amounts, or thresholds.
        if len(word) > 4 and word.endswith("ies"):
            word = word[:-3] + "y"
        elif len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
            word = word[:-1]
        if word not in QUESTION_STOP_WORDS and (len(word) > 2 or word.isdigit()):
            result.add(word)
    return result


def _is_generic_question(question: str) -> bool:
    normalized = re.sub(r"[^\w\s]", "", question.casefold())
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return any(pattern.search(normalized) for pattern in GENERIC_QUESTION_PATTERNS)


def normalize_nodes(value) -> dict:
    """Normalize model node shapes. Source and semantic checks run separately."""
    if not isinstance(value, dict):
        return {}

    result = {}
    for node_id, raw_node in value.items():
        if not isinstance(node_id, str) or not isinstance(raw_node, dict):
            continue
        question = raw_node.get("question")
        response_type = raw_node.get("response_type")
        if not isinstance(question, str) or not question.strip() or len(question.strip()) > 500:
            continue
        if response_type not in {"choice", "text"}:
            continue

        raw_excerpt = raw_node.get("source_excerpt")
        source_excerpt = raw_excerpt.strip() if isinstance(raw_excerpt, str) else ""
        raw_actions = raw_node.get("action_items", [])
        action_items = []
        if isinstance(raw_actions, list):
            action_items = [item.strip() for item in raw_actions if isinstance(item, str) and item.strip()][:10]

        node = {
            "type": "question",
            "response_type": response_type,
            "question": question.strip(),
            "source_excerpt": source_excerpt[:1000],
            "action_items": action_items,
        }
        if response_type == "choice":
            raw_choices = raw_node.get("choices")
            if not isinstance(raw_choices, list):
                continue
            choices = [choice.strip() for choice in raw_choices if isinstance(choice, str) and choice.strip()]
            if len(choices) < 2 or len(choices) > 8 or len(set(choices)) != len(choices):
                continue
            node["choices"] = choices
            # Targets are rebuilt into a safe sequential route after validation.
        result[node_id] = node
    return result


def validate_generated_questionnaire(model_data, source_text: str) -> tuple[dict, list[str]]:
    """Keep only questions with verifiable source excerpts and wording linked to that excerpt.

    This deterministic gate cannot prove semantic correctness, but it prevents an invented
    citation, generic catch-all prompt, or obviously unrelated question from being presented
    as a document-specific AI result.
    """
    if not isinstance(model_data, dict):
        return {}, ["invalid model response"]
    raw_nodes = model_data.get("nodes")
    if not isinstance(raw_nodes, dict):
        return {}, ["missing nodes object"]

    normalized_source = normalize_source_for_match(source_text)
    normalized_nodes = normalize_nodes(dict(list(raw_nodes.items())[:MAX_MODEL_NODES_TO_CHECK]))
    issues: list[str] = []
    accepted: list[dict] = []
    seen_questions: set[str] = set()

    for raw_id, raw_node in list(raw_nodes.items())[:MAX_MODEL_NODES_TO_CHECK]:
        if not isinstance(raw_id, str) or raw_id not in normalized_nodes:
            issues.append("invalid question structure")
            continue
        node = normalized_nodes[raw_id]
        question = node["question"]
        excerpt = node["source_excerpt"]

        if not excerpt:
            issues.append("missing source excerpt")
            continue
        if normalize_source_for_match(excerpt) not in normalized_source:
            issues.append("source excerpt not found in document")
            continue
        if _is_generic_question(question):
            issues.append("generic question")
            continue

        question_key = re.sub(r"[^\w\s]", " ", question.casefold())
        question_key = re.sub(r"\s+", " ", question_key).strip()
        if question_key in seen_questions:
            issues.append("duplicate question")
            continue

        question_terms = _content_words(question)
        excerpt_terms = _content_words(excerpt)
        overlap = question_terms & excerpt_terms
        if not question_terms or not overlap:
            issues.append("question not linked to source wording")
            continue
        minimum_overlap = 2 if len(question_terms) >= 3 else 1
        if len(overlap) < minimum_overlap:
            issues.append("question not sufficiently linked to source wording")
            continue
        if len(question_terms) >= 8 and (len(overlap) / len(question_terms)) < 0.15:
            issues.append("question not sufficiently linked to source wording")
            continue

        seen_questions.add(question_key)
        accepted.append(node)
        if len(accepted) >= MAX_AI_QUESTIONS:
            if len(raw_nodes) > MAX_AI_QUESTIONS:
                issues.append("question limit reached")
            break

    # Rebuild the graph instead of trusting model-supplied targets. This prevents dangling
    # node IDs, missing choice mappings, and cycles from breaking the guided review.
    rebuilt = {}
    for index, node in enumerate(accepted, start=1):
        node_id = f"node_{index}"
        next_id = f"node_{index + 1}" if index < len(accepted) else ""
        clean_node = dict(node)
        if clean_node["response_type"] == "choice":
            clean_node["targets"] = {choice: next_id for choice in clean_node["choices"]}
        else:
            clean_node["next_target"] = next_id
        rebuilt[node_id] = clean_node

    return rebuilt, issues


def make_manual_review_nodes(text: str) -> dict:
    """A clearly labelled fallback that asks about clarity, not compliance."""
    candidates = []
    for line in text.splitlines():
        cleaned = line.strip()
        if not cleaned or cleaned.startswith("--- Document:") or cleaned.startswith("--- Page"):
            continue
        if cleaned.startswith("[Table Row]"):
            cleaned = cleaned.removeprefix("[Table Row]").strip()
        if len(cleaned) >= 28 and cleaned not in candidates:
            candidates.append(cleaned)

    candidates = candidates[:MAX_REVIEW_ITEMS]
    nodes = {}
    for index, excerpt in enumerate(candidates, start=1):
        node_id = f"review_{index}"
        next_id = f"review_{index + 1}" if index < len(candidates) else ""
        nodes[node_id] = {
            "type": "question",
            "response_type": "choice",
            "question": "How clear is this instruction to you?",
            "choices": ["I understand this", "I need clarification"],
            "source_excerpt": excerpt[:1000],
            "targets": {
                "I understand this": next_id,
                "I need clarification": next_id,
            },
            "action_items": [],
        }
    return nodes


def extract_document_text(filename: str, content: bytes) -> str:
    lower_name = filename.lower()
    extracted_text = ""
    if lower_name.endswith(".pdf"):
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            for page_index, page in enumerate(pdf.pages, start=1):
                extracted_text += f"\n--- Page {page_index} ---\n"
                page_text = page.extract_text()
                if page_text:
                    extracted_text += page_text + "\n"
                for table in page.extract_tables() or []:
                    for row in table:
                        row_text = " | ".join(
                            str(cell).strip() for cell in row if cell is not None and str(cell).strip()
                        )
                        if row_text:
                            extracted_text += "[Table Row] " + row_text + "\n"
    elif lower_name.endswith(".docx"):
        doc = Document(io.BytesIO(content))
        for paragraph in doc.paragraphs:
            if paragraph.text.strip():
                extracted_text += paragraph.text + "\n"
        for table in doc.tables:
            for row in table.rows:
                row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                if row_text:
                    extracted_text += "[Table Row] " + row_text + "\n"
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {filename}. Choose PDF or DOCX.")
    return clean_text(extracted_text)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME}


@app.post("/parse-pdf")
async def parse_pdf(files: List[UploadFile] = File(...)):
    combined_text = ""
    file_names = []
    try:
        for uploaded in files:
            filename = uploaded.filename or "uploaded-document"
            lower_name = filename.lower()
            if not lower_name.endswith((".pdf", ".docx")):
                raise HTTPException(status_code=400, detail=f"Unsupported file type: {filename}. Choose PDF or DOCX.")
            content = await uploaded.read(MAX_FILE_BYTES + 1)
            if len(content) > MAX_FILE_BYTES:
                raise HTTPException(status_code=413, detail=f"{filename} is larger than 15 MB.")
            if not content:
                raise HTTPException(status_code=400, detail=f"{filename} is empty.")
            text = extract_document_text(filename, content)
            if text:
                combined_text += f"\n--- Document: {filename} ---\n{text}"
            file_names.append(filename)

        if not combined_text.strip():
            raise HTTPException(
                status_code=422,
                detail="No selectable text could be extracted. Scanned PDFs need OCR, which this prototype does not support yet.",
            )

        text_truncated = len(combined_text) > MAX_TEXT_CHARS
        model_input_text = combined_text[:MAX_TEXT_CHARS]
        document_title = file_names[0] if file_names else "Uploaded document"
        master_nodes = {}
        question_generation_mode = "ai"
        generation_notice = ""

        prompt_path = os.path.join(os.path.dirname(__file__), "prompt.txt")
        if os.path.exists(prompt_path):
            with open(prompt_path, "r", encoding="utf-8") as prompt_file:
                prompt_template = prompt_file.read()
            prompt = prompt_template.replace("{pdf_text}", model_input_text)
        else:
            prompt = (
                "Create a sequential questionnaire only from the following document text. "
                "Use exact source excerpts, valid JSON, response_type choice/text, and no invented facts.\n\n"
                + model_input_text
            )

        try:
            response = requests.post(
                OLLAMA_URL,
                json={
                    "model": MODEL_NAME,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0, "num_predict": 3500, "num_ctx": 16384},
                },
                timeout=90,
            )
            response.raise_for_status()
            content = response.json().get("response", "{}")
            model_data = extract_json_from_response(content)
            candidate_nodes, validation_issues = validate_generated_questionnaire(model_data, model_input_text)
            if candidate_nodes:
                master_nodes = candidate_nodes
                title_from_model = model_data.get("document_title")
                if (
                    isinstance(title_from_model, str)
                    and title_from_model.strip()
                    and normalize_source_for_match(title_from_model) in normalize_source_for_match(model_input_text)
                ):
                    document_title = title_from_model.strip()[:250]
                if validation_issues:
                    question_generation_mode = "ai_partial"
                    issue_count = len(validation_issues)
                    generation_notice = (
                        f"{issue_count} AI-generated question(s) were omitted because their source evidence or wording "
                        "could not be verified. This review may be incomplete; check the original document."
                    )
            else:
                question_generation_mode = "review_fallback"
                generation_notice = (
                    "The AI-generated questions did not pass source checks. These manual prompts only help you inspect "
                    "the extracted text; they are not an interpretation or compliance assessment."
                )
        except (requests.RequestException, ValueError, KeyError, AttributeError, TypeError) as model_error:
            print(f"Local AI unavailable or returned invalid data: {model_error}")
            question_generation_mode = "review_fallback"
            generation_notice = "The local AI could not generate a verified questionnaire. These manual prompts only help you inspect the extracted text; they do not assess compliance."

        if not master_nodes:
            master_nodes = make_manual_review_nodes(model_input_text)
            question_generation_mode = "review_fallback"
            if not master_nodes:
                generation_notice = "Text was extracted, but no useful review prompts could be created. You can read the extracted text in the source panel."

        start_node = next(iter(master_nodes), "")
        return {
            "document_title": document_title,
            "doc_type": "instruction_or_form",
            "start_node": start_node,
            "nodes": master_nodes,
            "text_preview": combined_text[:6000],
            "question_generation_mode": question_generation_mode,
            "generation_notice": generation_notice,
            "text_truncated": text_truncated,
        }
    except HTTPException:
        raise
    except Exception as error:
        print(f"Document parsing error: {error}")
        raise HTTPException(status_code=500, detail="We could not process this document. Try another PDF or DOCX file.") from error


def report_paragraph(value, style):
    # Escape document/user content so angle brackets can't be treated as ReportLab markup.
    escaped = html.escape(str(value if value is not None else ""))
    return Paragraph(escaped.replace("\n", "<br/>"), style)


@app.post("/generate-filled-pdf")
async def generate_filled_pdf(data: dict):
    temp_path: Optional[str] = None
    try:
        answers = data.get("answers", {}) if isinstance(data, dict) else {}
        nodes = data.get("nodes", {}) if isinstance(data, dict) else {}
        if not isinstance(answers, dict) or not isinstance(nodes, dict):
            raise HTTPException(status_code=422, detail="Answers or question data has an invalid format.")

        with tempfile.NamedTemporaryFile(prefix="papertrace-", suffix=".pdf", delete=False) as temp_file:
            temp_path = temp_file.name

        document_title = str(data.get("document_title") or "Document review")
        doc = SimpleDocTemplate(
            temp_path,
            pagesize=letter,
            rightMargin=44,
            leftMargin=44,
            topMargin=44,
            bottomMargin=44,
            title="PaperTrace review report",
        )
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle(
            "PaperTraceTitle", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=19,
            leading=24, textColor="#202B49", spaceAfter=8,
        )
        body_style = ParagraphStyle(
            "PaperTraceBody", parent=styles["BodyText"], fontName="Helvetica", fontSize=10.5,
            leading=15, textColor="#334155", spaceAfter=7,
        )
        section_style = ParagraphStyle(
            "PaperTraceSection", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=13,
            leading=17, textColor="#3D50D8", spaceBefore=12, spaceAfter=8,
        )
        story = [
            Paragraph("PAPERTRACE · REVIEW REPORT", title_style),
            report_paragraph(document_title, body_style),
            Spacer(1, 12),
            report_paragraph("This report records your responses and source excerpts. It is not a completed original form or a legal/compliance certification.", body_style),
            Spacer(1, 10),
        ]

        action_entries = []
        for index, (node_id, answer) in enumerate(answers.items(), start=1):
            node = nodes.get(node_id, {}) if isinstance(nodes.get(node_id, {}), dict) else {}
            story.append(Paragraph(f"Question {index}", section_style))
            story.append(report_paragraph(node.get("question", "Review item"), body_style))
            if node.get("source_excerpt"):
                story.append(report_paragraph("Source excerpt: " + str(node.get("source_excerpt")), body_style))
            story.append(report_paragraph("Your response: " + str(answer), body_style))
            for action in node.get("action_items", []) if isinstance(node.get("action_items", []), list) else []:
                action_entries.append(str(action))
            story.append(Spacer(1, 5))

        story.append(Paragraph("Actions mentioned in the document", section_style))
        unique_actions = list(dict.fromkeys(action_entries))
        if unique_actions:
            for action in unique_actions:
                story.append(report_paragraph("• " + action, body_style))
        else:
            story.append(report_paragraph("No action items were generated for the recorded responses. Check the original document for any remaining steps.", body_style))

        doc.build(story)
        return FileResponse(
            temp_path,
            media_type="application/pdf",
            filename="PaperTrace-review-report.pdf",
            background=BackgroundTask(os.unlink, temp_path),
        )
    except HTTPException:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
        raise
    except Exception as error:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
        print(f"Report generation error: {error}")
        raise HTTPException(status_code=500, detail="The review report could not be generated.") from error
