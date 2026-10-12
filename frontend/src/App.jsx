import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Download,
  FileText,
  FileUp,
  Info,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const MAX_FILE_SIZE = 15 * 1024 * 1024;
// 100% is the default. 200% is twice the default size; 300% is three times.
const READING_SCALES = { normal: 1, large: 2, xlarge: 3 };

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const [file, setFile] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [treeData, setTreeData] = useState(null);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(true);
  const [leftPanelPercent, setLeftPanelPercent] = useState(48);
  const [isResizingPanels, setIsResizingPanels] = useState(false);
  const workspaceRef = useRef(null);
  const resizingPanelsRef = useRef(false);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [textSize, setTextSize] = useState('normal');
  const [showHelp, setShowHelp] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!file) {
      setPdfUrl('');
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Render every returned question together. Do not walk start_node/targets in
  // the UI: sequential navigation hides later questions and makes the review
  // feel complete before users can see the entire questionnaire.
  const questions = useMemo(() => {
    const nodes = treeData?.nodes;
    if (!nodes || typeof nodes !== 'object') return [];
    return Object.entries(nodes).map(([id, node]) => ({ id, ...node }));
  }, [treeData]);
  const answeredCount = questions.filter((node) => String(answers[node.id] ?? '').trim().length > 0).length;
  const allAnswered = questions.length > 0 && answeredCount === questions.length;
  const actionItems = useMemo(() => {
    const all = [];
    questions.forEach((node) => {
      if (String(answers[node.id] ?? '').trim() && Array.isArray(node.action_items)) all.push(...node.action_items);
    });
    return [...new Set(all)];
  }, [questions, answers]);

  const updateAnswer = (nodeId, value) => {
    setAnswers((existing) => ({ ...existing, [nodeId]: value }));
    setError('');
  };

  const selectFile = (candidate) => {
    setError('');
    if (!candidate) return;
    const lowerName = candidate.name.toLowerCase();
    if (!lowerName.endsWith('.pdf') && !lowerName.endsWith('.docx')) {
      setError('Choose a PDF or DOCX document. Other file types are not supported yet.');
      return;
    }
    if (candidate.size > MAX_FILE_SIZE) {
      setError('This file is larger than 15 MB. Choose a smaller document for this prototype.');
      return;
    }
    setFile(candidate);
    setTreeData(null);
    setAnswers({});
    setZoomLevel(100);
  };

  const handleFileInput = (event) => {
    selectFile(event.target.files?.[0]);
    // Allow selecting the same file again after an error or reset.
    event.target.value = '';
  };

  const handleDrop = (event) => {
    event.preventDefault();
    selectFile(event.dataTransfer.files?.[0]);
  };

  const startPanelResize = (event) => {
    if (window.innerWidth <= 850) return;
    event.preventDefault();
    resizingPanelsRef.current = true;
    setIsResizingPanels(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const movePanelDivider = (event) => {
    if (!resizingPanelsRef.current || !workspaceRef.current) return;
    const bounds = workspaceRef.current.getBoundingClientRect();
    const styles = window.getComputedStyle(workspaceRef.current);
    const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
    // Two 16px gaps and the 8px divider use 40px of the content width.
    const usableWidth = Math.max(1, bounds.width - paddingLeft - paddingRight - 40);
    const contentLeft = bounds.left + paddingLeft;
    const ratio = ((event.clientX - contentLeft - 20) / usableWidth) * 100;
    setLeftPanelPercent(Math.min(62, Math.max(38, ratio)));
  };

  const finishPanelResize = () => {
    resizingPanelsRef.current = false;
    setIsResizingPanels(false);
  };

  const resizePanelsWithKeyboard = (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -3 : 3;
      setLeftPanelPercent((value) => Math.min(62, Math.max(38, value + delta)));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setLeftPanelPercent(38);
    } else if (event.key === 'End') {
      event.preventDefault();
      setLeftPanelPercent(62);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      setLeftPanelPercent(48);
    }
  };

  const analyzeDocument = async () => {
    if (!file) {
      fileInputRef.current?.click();
      return;
    }
    setLoading(true);
    setError('');
    const formData = new FormData();
    formData.append('files', file);
    try {
      const response = await axios.post(`${API_BASE_URL}/parse-pdf`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 150000,
      });
      setTreeData(response.data);
      setAnswers({});
      if (!response.data?.nodes || !Object.keys(response.data.nodes).length) {
        setError('We extracted the document text, but could not create guided questions. Check that your local AI service is running, or use the source preview to continue manually.');
      }
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'We could not read this document. Check that the FastAPI backend is running and try again.');
    } finally {
      setLoading(false);
    }
  };

  const resetAnswers = () => {
    setAnswers({});
    setError('');
  };

  const downloadReport = async () => {
    if (!treeData) return;
    setDownloading(true);
    setError('');
    try {
      const response = await axios.post(
        `${API_BASE_URL}/generate-filled-pdf`,
        { answers: Object.fromEntries(Object.entries(answers).filter(([, value]) => String(value ?? '').trim())), nodes: treeData.nodes || {}, document_title: treeData.document_title || file?.name || 'Document' },
        { responseType: 'blob', timeout: 60000 },
      );
      const url = URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'PaperTrace-review-report.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('The report could not be generated. Check that the backend is running, then try again.');
    } finally {
      setDownloading(false);
    }
  };

  const isDocx = Boolean(file?.name.toLowerCase().endsWith('.docx'));
  const progressText = `${answeredCount} of ${questions.length} answered`;

  return (
    <div className={`app-shell text-${textSize}`} style={{ '--reading-scale': READING_SCALES[textSize] || 1 }}>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="PaperTrace home">
          <span className="brand-mark" aria-hidden="true">PT</span>
          <span>PaperTrace</span>
        </a>
        <div className="topbar-actions">
          <button className="icon-button help-button" onClick={() => setShowHelp((value) => !value)} aria-label="About PaperTrace" title="About PaperTrace">
            <CircleHelp size={18} />
          </button>
          {file && <button className="button button-primary button-small" onClick={() => fileInputRef.current?.click()}>
            <FileUp size={16} /> <span>Change file</span>
          </button>}
          <input ref={fileInputRef} className="visually-hidden" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={handleFileInput} aria-label="Choose a PDF or DOCX document" />
        </div>
      </header>

      {showHelp && (
        <div className="help-popover" role="status">
          <strong>About PaperTrace</strong>
          <p>AI suggests questions. Check the original before acting.</p>
          <button className="text-button" onClick={() => setShowHelp(false)}>Close</button>
        </div>
      )}

      <main
        id="top"
        ref={workspaceRef}
        className={`workspace ${showSource ? '' : 'source-hidden'} ${isResizingPanels ? 'is-resizing-panels' : ''}`}
        style={showSource ? { gridTemplateColumns: `minmax(0, ${leftPanelPercent}fr) 8px minmax(0, ${100 - leftPanelPercent}fr)` } : undefined}
      >
        <section className="work-column" aria-label="Guided document review">
          <div className="page-heading">
            <div>
              <h1>Read the requirement.<br />Keep your footing.</h1>
              <p className="page-subtitle">All questions in one list. Source stays visible.</p>
            </div>
            {treeData && <div className="saved-pill"><span className="saved-dot" /> {progressText}</div>}
          </div>

          {!file ? (
            <div
              className="upload-card"
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
            >
              <div className="upload-illustration"><FileUp size={29} strokeWidth={1.7} /></div>
              <h2>Bring the document into focus.</h2>
              <button className="button button-primary" onClick={() => fileInputRef.current?.click()}><FileUp size={17} /> Choose a document</button>
              <div className="upload-or"><span /> or drop the file on this page <span /></div>
              <div className="file-support"><span><Check size={14} /> PDF</span><span><Check size={14} /> DOCX</span><span>Up to 15 MB</span></div>
              <div className="privacy-note"><LockKeyhole size={15} /> Sensitive file? Upload with care.</div>
            </div>
          ) : (
            <div className="document-card">
              <div className="file-icon"><FileText size={22} /></div>
              <div className="document-meta">
                <strong title={file.name}>{file.name}</strong>
                <span>{isDocx ? 'Word document' : 'PDF document'} · {formatBytes(file.size)}</span>
              </div>
              {treeData && <span className="file-status"><CheckCircle2 size={15} /> Loaded</span>}
              {!treeData && <span className="file-status file-status-muted"><Clock3 size={15} /> Ready to review</span>}
              <button className="icon-button" onClick={() => { setFile(null); setTreeData(null); setAnswers({}); setError(''); }} aria-label="Remove selected document" title="Remove document"><RotateCcw size={16} /></button>
            </div>
          )}

          {file && !treeData && (
            <div className="analyze-panel">
              <div className="analyze-copy">
                <Sparkles size={18} />
                <div><strong>AI-guided review</strong><span>Check each suggestion against the source.</span></div>
              </div>
              <button className="button button-primary" onClick={analyzeDocument} disabled={loading}>
                {loading ? <><LoaderCircle className="spin" size={17} /> Reading document…</> : <><Sparkles size={16} /> Start guided review <ArrowRight size={16} /></>}
              </button>
            </div>
          )}

          {error && <div className="alert alert-error" role="alert"><Info size={18} /><span>{error}</span><button className="alert-dismiss" aria-label="Dismiss message" onClick={() => setError('')}>×</button></div>}

          {treeData?.generation_notice && ['review_fallback', 'ai_partial'].includes(treeData.question_generation_mode) && (
            <div className="alert alert-warning" role="status">
              <Info size={18} />
              <span>
                <strong>{treeData.question_generation_mode === 'ai_partial' ? 'Partial AI review.' : 'Manual review mode.'}</strong>{' '}
                {treeData.generation_notice}
              </span>
            </div>
          )}
          {treeData?.text_truncated && (
            <div className="alert alert-warning" role="status">
              <Info size={18} />
              <span>This document is longer than the current prototype can send to the AI at once. The questionnaire may not cover every section; check the entire original document.</span>
            </div>
          )}

          {treeData && questions.length > 0 && (
            <>
              <div className="section-heading question-list-heading">
                <div>
                  <h2>Questions</h2>
                  <p className="section-caption">Answer what you can. Change answers anytime.</p>
                </div>
                <div className="question-heading-actions">
                  <span className="question-progress" aria-live="polite">{progressText}</span>
                  <button className="text-button reset-link" onClick={resetAnswers}><RotateCcw size={14} /> Clear answers</button>
                </div>
              </div>

              <form className="question-list" aria-label="Document questions" onSubmit={(event) => event.preventDefault()}>
                {questions.map((node, index) => {
                  const value = answers[node.id] ?? '';
                  const isAnswered = String(value).trim().length > 0;
                  const choices = node.choices || (node.targets ? Object.keys(node.targets) : ['Yes', 'No']);
                  const questionId = `question-${node.id}`;
                  const answerId = `answer-${node.id}`;
                  return (
                    <article className={`question-card question-list-item ${isAnswered ? 'is-answered' : 'is-unanswered'}`} key={node.id} aria-labelledby={questionId}>
                      <div className="question-card-top">
                        <span className="step-chip">QUESTION {String(index + 1).padStart(2, '0')}</span>
                        <span className={`question-status ${isAnswered ? 'status-answered' : 'status-unanswered'}`}>
                          {isAnswered ? <><Check size={13} /> Answered</> : 'Not answered'}
                        </span>
                      </div>
                      <h3 id={questionId}>{node.question || `Review question ${index + 1}`}</h3>
                      {node.source_excerpt && (
                        <details className="source-quote">
                          <summary><span><FileText size={15} /> View source wording</span><ChevronDown size={16} /></summary>
                          <blockquote>{node.source_excerpt}</blockquote>
                        </details>
                      )}
                      {node.response_type === 'text' ? (
                        <div className="answer-field">
                          <label htmlFor={answerId}>Your answer</label>
                          <textarea
                            id={answerId}
                            rows={2}
                            value={value}
                            onChange={(event) => updateAnswer(node.id, event.target.value)}
                            placeholder="Type your answer…"
                          />
                        </div>
                      ) : (
                        <fieldset className="choice-group">
                          <legend>Choose one</legend>
                          {choices.map((choice) => (
                            <label key={choice} className={`choice-option ${value === choice ? 'is-selected' : ''}`}>
                              <input
                                type="radio"
                                name={`answer-${node.id}`}
                                value={choice}
                                checked={value === choice}
                                onChange={() => updateAnswer(node.id, choice)}
                              />
                              <span className="choice-indicator">{value === choice && <Check size={14} />}</span>
                              <span className="choice-label">{choice}</span>
                            </label>
                          ))}
                        </fieldset>
                      )}
                    </article>
                  );
                })}
              </form>

              <section className="answer-review" aria-labelledby="report-title">
                <div className="answer-review-heading">
                  <div><h3 id="report-title">Review report</h3></div>
                  <span>{progressText}</span>
                </div>
                {allAnswered ? (
                  <div className="completion-notice" role="status"><CheckCircle2 size={18} /> All listed questions answered. Check the original before export.</div>
                ) : (
                  <p className="answer-review-intro">Unanswered questions stay visible above.</p>
                )}
                {actionItems.length > 0 && (
                  <div className="action-box"><div className="action-box-title"><Info size={16} /><strong>Suggested actions</strong></div><ul>{actionItems.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}</ul></div>
                )}
                <div className="report-row">
                  <div><span>{progressText} · Original unchanged.</span></div>
                  <button className="button button-primary report-download-button" onClick={downloadReport} disabled={answeredCount === 0 || downloading}>
                    {downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                    {downloading ? 'Preparing report…' : 'Download review report'}
                  </button>
                </div>
              </section>
            </>
          )}

          {treeData && questions.length === 0 && (
            <div className="empty-state-panel"><CircleHelp size={25} /><h2>No guided questions yet</h2><p>The document text may still be available in the source panel. Check the local AI service and try parsing again.</p><button className="button button-secondary" onClick={analyzeDocument} disabled={loading}>Try again</button></div>
          )}

          <footer className="work-footer"><span>Prototype · Verify against the original.</span><button className="text-button" onClick={() => setShowSource((value) => !value)}>{showSource ? 'Hide source' : 'Show source'}</button></footer>
        </section>

        {showSource && (
          <div
            className="panel-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize review and source panels"
            aria-valuemin={38}
            aria-valuemax={62}
            aria-valuenow={leftPanelPercent}
            aria-valuetext={`Review panel ${leftPanelPercent} percent; source panel ${100 - leftPanelPercent} percent`}
            tabIndex={0}
            onPointerDown={startPanelResize}
            onPointerMove={movePanelDivider}
            onPointerUp={finishPanelResize}
            onPointerCancel={finishPanelResize}
            onLostPointerCapture={finishPanelResize}
            onKeyDown={resizePanelsWithKeyboard}
            onDoubleClick={() => setLeftPanelPercent(48)}
            title="Drag to resize. Use arrow keys to adjust; press Enter to reset."
          >
            <span aria-hidden="true" />
          </div>
        )}

        {showSource && (
          <aside className="source-column" aria-label="Original document preview">
            <div className="source-header">
              <div><h2>Original document</h2></div>
              {file && !isDocx && <div className="zoom-controls"><button className="icon-button" onClick={() => setZoomLevel((value) => Math.max(50, value - 10))} title="Zoom out" aria-label="Zoom out"><ZoomOut size={16} /></button><span>{zoomLevel}%</span><button className="icon-button" onClick={() => setZoomLevel((value) => Math.min(200, value + 10))} title="Zoom in" aria-label="Zoom in"><ZoomIn size={16} /></button></div>}
            </div>
            <div className="source-file-label">{file ? <><FileText size={15} /><span title={file.name}>{file.name}</span></> : <><FileText size={15} /><span>Preview will appear here</span></>}</div>
            <div className="source-viewer">
              {!file ? (
                <div className="source-empty"><div><FileText size={28} /><span>Your document appears here.</span><small>PDF or DOCX</small></div></div>
              ) : isDocx ? (
                <div className="docx-preview">
                  <div className="docx-page-label">DOCUMENT TEXT</div>
                  {treeData?.text_preview ? <pre>{treeData.text_preview}</pre> : <div className="preview-prompt">Start the guided review to extract the text from this Word document.</div>}
                </div>
              ) : (
                <iframe key={`${pdfUrl}-${zoomLevel}`} title="Original PDF document preview" src={`${pdfUrl}#toolbar=0&navpanes=0&zoom=${zoomLevel}`} />
              )}
            </div>
            <div className="source-footer"><LockKeyhole size={13} /><span>Original unchanged · Export is separate.</span></div>
          </aside>
        )}
      </main>

      <div className="accessibility-toolbar" role="group" aria-label="Interface text size">
        <span>Text size</span>
        <button className={textSize === 'normal' ? 'active' : ''} onClick={() => setTextSize('normal')} aria-label="Text size 100 percent (default)" title="Text size 100 percent (default)" aria-pressed={textSize === 'normal'}>100%</button>
        <button className={textSize === 'large' ? 'active' : ''} onClick={() => setTextSize('large')} aria-label="Text size 200 percent (twice the default size)" title="Text size 200 percent (twice the default size)" aria-pressed={textSize === 'large'}>200%</button>
        <button className={textSize === 'xlarge' ? 'active' : ''} onClick={() => setTextSize('xlarge')} aria-label="Text size 300 percent (three times the default size)" title="Text size 300 percent (three times the default size)" aria-pressed={textSize === 'xlarge'}>300%</button>
      </div>
    </div>
  );
}
