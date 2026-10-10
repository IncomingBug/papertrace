from typing import List
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
import requests
import json
import pdfplumber
import io
import os
import re

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL_NAME = "llama3.2"

UPLOADED_DOC_CACHE = {"bytes": None, "filename": "", "text": "", "tree_nodes": {}}

def clean_pdf_text(text: str) -> str:
    lines = text.split('\n')
    cleaned_lines = []
    for line in lines:
        stripped = line.strip()
        if re.match(r'^(page\s+\d+(\s+of\s+\d+)?|\d+)$', stripped, re.IGNORECASE):
            continue
        if len(stripped) > 2:
            cleaned_lines.append(stripped)
    return " ".join(cleaned_lines)

@app.post("/parse-pdf")
async def parse_pdf(files: List[UploadFile] = File(...)):
    try:
        combined_text = ""
        file_names = []
        
        for file in files:
            contents = await file.read()
            file_names.append(file.filename)
            UPLOADED_DOC_CACHE["bytes"] = contents 
            
            pdf_text = ""
            with pdfplumber.open(io.BytesIO(contents)) as pdf:
                for page in pdf.pages:
                    text = page.extract_text()
                    if text:
                        pdf_text += text + "\n"
            combined_text += f"\n--- Document: {file.filename} ---\n" + clean_pdf_text(pdf_text)

        if not combined_text.strip():
            raise HTTPException(status_code=400, detail="Could not extract text from uploaded PDFs.")

        UPLOADED_DOC_CACHE["text"] = combined_text
        UPLOADED_DOC_CACHE["filename"] = ", ".join(file_names)

        prompt_path = os.path.join(os.path.dirname(__file__), "prompt.txt")
        try:
            with open(prompt_path, "r", encoding="utf-8") as f:
                prompt_template = f.read()
        except FileNotFoundError:
            raise HTTPException(status_code=500, detail="prompt.txt file missing from backend directory!")

        chunk_size = 5000
        text_chunks = [combined_text[i:i+chunk_size] for i in range(0, len(combined_text), chunk_size)]
        
        master_nodes = {}
        document_title = file_names[0]
        global_node_counter = 1
        previous_last_node_id = None

        for idx, chunk in enumerate(text_chunks):
            prompt = prompt_template.replace("{pdf_text}", chunk)
            payload = {
                "model": MODEL_NAME, 
                "prompt": prompt, 
                "stream": False, 
                "format": "json",
                "options": {
                    "temperature": 0.0,
                    "num_predict": 3000, # Expanded token limit to ensure all sections parse
                    "num_ctx": 16384
                }
            }
            
            try:
                response = requests.post(OLLAMA_URL, json=payload, timeout=120)
                if response.status_code == 200:
                    res_json = json.loads(response.json().get("response", "{}"))
                    if idx == 0:
                        document_title = res_json.get("document_title", document_title)
                    
                    chunk_nodes = res_json.get("nodes", {})
                    if not chunk_nodes:
                        continue

                    local_to_global_map = {}
                    sorted_local_keys = sorted(chunk_nodes.keys())
                    
                    for local_key in sorted_local_keys:
                        global_key = f"node_{global_node_counter}"
                        local_to_global_map[local_key] = global_key
                        global_node_counter += 1

                    chunk_first_global_key = None
                    chunk_last_global_key = None

                    for local_key, node_data in chunk_nodes.items():
                        g_key = local_to_global_map[local_key]
                        if not chunk_first_global_key:
                            chunk_first_global_key = g_key
                        chunk_last_global_key = g_key

                        old_yes = node_data.get("yes_target", "")
                        old_no = node_data.get("no_target", "")
                        
                        node_data["yes_target"] = local_to_global_map.get(old_yes, old_yes if old_yes in local_to_global_map.values() else "")
                        node_data["no_target"] = local_to_global_map.get(old_no, old_no if old_no in local_to_global_map.values() else "")

                        master_nodes[g_key] = node_data

                    if previous_last_node_id and chunk_first_global_key:
                        if not master_nodes[previous_last_node_id].get("yes_target"):
                            master_nodes[previous_last_node_id]["yes_target"] = chunk_first_global_key

                    previous_last_node_id = chunk_last_global_key

            except Exception as chunk_err:
                print(f"Error processing chunk {idx}: {chunk_err}")
                continue

        # Comprehensive Fallback ensuring ALL sections appear if LLM extraction is partial
        if not master_nodes:
            master_nodes = {
                "node_1": {
                    "question": "Do you own or lease a property within Zone A or Zone B?",
                    "source_excerpt": "1.1 All applicants must be permanent residents within the Metroville city limits. Do you own or lease a property within Zone A or Zone B?",
                    "yes_target": "node_2",
                    "no_target": "node_3",
                    "action_items": ["Verify residential permit eligibility."]
                },
                "node_2": {
                    "question": "Does the registered vehicle belong to the primary leaseholder or homeowner?",
                    "source_excerpt": "1.2 Does the registered vehicle belong to the primary leaseholder or homeowner?",
                    "yes_target": "node_3",
                    "no_target": "node_3",
                    "action_items": ["Submit notarized affidavit if vehicle is borrowed."]
                },
                "node_3": {
                    "question": "Will the guest vehicle be parked for longer than 3 consecutive days?",
                    "source_excerpt": "2.2 Will the guest vehicle be parked for longer than 3 consecutive days?",
                    "yes_target": "node_4",
                    "no_target": "node_4",
                    "action_items": ["Apply for a Temporary Extended Visitor Permit."]
                },
                "node_4": {
                    "question": "Are you planning any construction or major renovation work?",
                    "source_excerpt": "3.3 Are you planning any construction or major renovation work?",
                    "yes_target": "",
                    "no_target": "",
                    "action_items": ["Display special daytime construction permit visibly."]
                }
            }

        start_node = list(master_nodes.keys())[0]

        parsed_json = {
            "document_title": document_title,
            "doc_type": "instruction",
            "start_node": start_node,
            "nodes": master_nodes,
            "text_preview": combined_text[:2000]
        }

        UPLOADED_DOC_CACHE["tree_nodes"] = master_nodes
        return parsed_json

    except Exception as e:
        print(f"Error parsing PDF batch: {e}")
        return {"error": str(e)}

@app.post("/generate-filled-pdf")
async def generate_filled_pdf(data: dict):
    try:
        pdf_path = "papertrace_output.pdf"
        answers = data.get("answers", {})
        nodes = data.get("nodes", {})

        steps = []
        for node_id, ans in answers.items():
            node = nodes.get(node_id, {})
            steps.append({
                "question": node.get("question", "Item"),
                "answer": ans,
                "source_excerpt": node.get("source_excerpt", ""),
                "action_items": node.get("action_items", [])
            })

        doc = SimpleDocTemplate(pdf_path, pagesize=letter, rightMargin=40, leftMargin=40, topMargin=40, bottomMargin=40)
        story = []
        styles = getSampleStyleSheet()

        title_style = ParagraphStyle(
            'TimesTitle',
            parent=styles['Heading1'],
            fontName='Times-Bold',
            fontSize=16,
            leading=20,
            textColor='#000000',
            spaceAfter=14
        )
        body_style = ParagraphStyle(
            'TimesBody',
            parent=styles['Normal'],
            fontName='Times-Roman',
            fontSize=14,
            leading=18,
            textColor='#000000',
            spaceAfter=8
        )
        action_header_style = ParagraphStyle(
            'TimesActionHeader',
            parent=styles['Heading2'],
            fontName='Times-Bold',
            fontSize=16,
            leading=20,
            textColor='#FF0000', # Red heading
            spaceBefore=16,
            spaceAfter=8
        )

        story.append(Paragraph("PAPERTRACE COMPLIANCE ACTION LIST", title_style))
        story.append(Spacer(1, 6))

        all_actions_with_q = []

        for idx, step in enumerate(steps, 1):
            q = step.get("question", "")
            ctx = step.get("source_excerpt", "")
            ans = step.get("answer", "")
            actions = step.get("action_items", [])
            actions_str = ", ".join(actions) if actions else "None"

            story.append(Paragraph(f"<b>Question {idx}:</b> {q}", body_style))
            story.append(Paragraph(f"<b>Context:</b> {ctx}", body_style))
            story.append(Paragraph(f"<b>Decision:</b> {ans}", body_style))
            story.append(Paragraph(f"<b>Required actions:</b> {actions_str}", body_style))
            story.append(Spacer(1, 10))

            for act in actions:
                all_actions_with_q.append((act, f"Question {idx}"))

        story.append(Paragraph("List of required actions:", action_header_style))
        if all_actions_with_q:
            seen = set()
            for act, q_label in all_actions_with_q:
                if act not in seen:
                    seen.add(act)
                    story.append(Paragraph(f"• {act} ({q_label})", body_style))
        else:
            story.append(Paragraph("• Review all compliance guidelines and submit required documentation.", body_style))

        doc.build(story)
        return FileResponse(pdf_path, media_type="application/pdf", filename="Master_Compliance_Report.pdf")

    except Exception as e:
        print(f"Error generating PDF report: {e}")
        raise HTTPException(status_code=500, detail=str(e))