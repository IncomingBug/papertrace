import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import axios from 'axios';
import {
  Download,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  FileText,
  CheckCircle2,
  AlertCircle,
  X,
  Eye,
} from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function sortNodeEntries(nodes) {
  return Object.entries(nodes || {})
    .filter(([, node]) => node && (node.question || node.type === 'question'))
    .sort(([a], [b]) => {
      const ai = Number((a.match(/\d+/) || [Number.MAX_SAFE_INTEGER])[0]);
      const bi = Number((b.match(/\d+/) || [Number.MAX_SAFE_INTEGER])[0]);
      return ai - bi;
    })
    .map(([id, node], index) => ({ id, ...node, __index: index }));
}

function getNodeActions(node, answer) {
  if (answer === undefined || answer === null || answer === '') return [];
  const uniqueActions = (items) => {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    return items.filter((item) => {
      if (typeof item !== 'string' || !item.trim()) return false;
      const key = item.trim().replace(/\s+/g, ' ').replace(/[.!?;:]+$/, '').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const byAnswer = node.actions_by_answer ?? node.action_items_by_answer;
  if (byAnswer && typeof byAnswer === 'object' && !Array.isArray(byAnswer)) {
    return uniqueActions(byAnswer[String(answer)]);
  }
  if (node.response_type === 'choice' && Array.isArray(node.choices) && node.choices.includes('Yes') && node.choices.includes('No')) {
    return [];
  }
  return uniqueActions(node.action_items);
}

function dependencyState(node, answers) {
  const raw = node.depends_on ?? node.dependsOn ?? node.dependency;
  if (!raw) return { state: 'ready', reason: '' };

  const dependencies = Array.isArray(raw) ? raw : [raw];
  for (const dep of dependencies) {
    if (typeof dep === 'string') {
      if (answers[dep] === undefined) {
        return { state: 'waiting', reason: 'Answer the linked question first.' };
      }
      continue;
    }
    if (!dep || typeof dep !== 'object') continue;

    const parentId = dep.node_id || dep.question_id || dep.id || dep.question;
    if (!parentId) continue;
    if (answers[parentId] === undefined) {
      return { state: 'waiting', reason: 'Answer the linked question first.' };
    }

    const expected = dep.answer ?? dep.expected_answer ?? dep.value;
    if (expected !== undefined && String(answers[parentId]) !== String(expected)) {
      return { state: 'not-applicable', reason: 'This follow-up does not apply to your answer.' };
    }
  }
  return { state: 'ready', reason: '' };
}

/* =========================================================================
   Sub-components
   ========================================================================= */

const Header = React.memo(function Header({ textScale, setTextScale }) {
  return (
    <header className="pt-header">
      <div className="pt-brand">PaperTrace</div>
      <div className="pt-header-note">
        <span className="pt-header-spark" aria-hidden="true" />
        <div className="pt-accessibility" role="group" aria-label="Text size">
          <span>Text size</span>
          {[100, 200, 300].map((scale) => (
            <button
              key={scale}
              type="button"
              className={textScale === scale ? 'is-active' : ''}
              aria-pressed={textScale === scale}
              aria-label={`${scale}% text size`}
              onClick={() => setTextScale(scale)}
            >
              {scale}%
            </button>
          ))}
        </div>
      </div>
    </header>
  );
});

const UploadSection = React.memo(function UploadSection({
  file,
  loading,
  dragActive,
  setDragActive,
  fileInputRef,
  chooseFile,
  handleFileChange,
  handleUpload,
}) {
  return (
    <div
      className={`pt-upload-area ${dragActive ? 'pt-intro--dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        chooseFile(event.dataTransfer.files?.[0]);
      }}
    >
      <h2>Bring the document into focus.</h2>
      <p className="pt-upload-description">Choose a PDF or DOCX to build a source-linked review.</p>

      <input
        ref={fileInputRef}
        className="pt-file-input"
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={handleFileChange}
        aria-label="Choose a PDF or DOCX document"
      />

      <div className="pt-upload-actions">
        <button
          className="pt-glass-button"
          type="button"
          onClick={() => fileInputRef.current?.click()}
        >
          <span className="pt-button-spark" aria-hidden="true">→</span>
          <span>{file ? 'Change document' : 'Choose a document'}</span>
          <span className="pt-button-arrow" aria-hidden="true">←</span>
        </button>
        {file && (
          <button
            className="pt-soft-button pt-parse-button"
            type="button"
            onClick={handleUpload}
            disabled={loading}
          >
            {loading ? <span className="pt-spinner" aria-hidden="true" /> : <FileText size={16} />}
            {loading ? 'Reading…' : 'Start review'}
          </button>
        )}
      </div>
    </div>
  );
});

// Memoized Question Card to prevent unnecessary re-renders when typing in other inputs
const QuestionCard = React.memo(function QuestionCard({
  node,
  index,
  answer,
  textInputVal,
  onTextChange,
  onTextSubmit,
  onAnswer,
  answers,
}) {
  const isAnswered = answer !== undefined && answer !== null && String(answer).trim() !== '';
  const applicability = dependencyState(node, answers);
  const choices = Array.isArray(node.choices) && node.choices.length
    ? node.choices
    : (node.response_type === 'choice' ? Object.keys(node.targets || {}) : ['Yes', 'No']);
  const nodeActions = getNodeActions(node, answer);
  const isDisabled = applicability.state !== 'ready';

  return (
    <article className={`pt-question ${isAnswered ? 'pt-question--answered' : ''} ${isDisabled ? 'pt-question--disabled' : ''}`}>
      <div className="pt-question-top">
        <span className="pt-question-number">{String(index + 1).padStart(2, '0')}</span>
        <span className="pt-question-status">
          {isAnswered ? <><CheckCircle2 size={14} /> Answered</> : applicability.state === 'waiting' ? 'Waiting' : applicability.state === 'not-applicable' ? 'Not applicable' : 'Needs answer'}
        </span>
      </div>
      <h3>{node.question || `Requirement ${index + 1}`}</h3>

      <details className="pt-source-details" open={node.compound_unit || undefined}>
        <summary><Eye size={14} /> Original wording</summary>
        <blockquote>{node.source_excerpt || 'No source excerpt was provided for this question.'}</blockquote>
      </details>

      {applicability.state !== 'ready' && (
        <p className={`pt-applicability-note ${applicability.state === 'not-applicable' ? 'is-na' : ''}`}>
          {applicability.reason}
        </p>
      )}

      {node.response_type === 'text' ? (
        <div className="pt-text-answer">
          <label className="pt-sr-only" htmlFor={`answer-${node.id}`}>Your answer to question {index + 1}</label>
          <input
            id={`answer-${node.id}`}
            type="text"
            value={textInputVal !== undefined ? textInputVal : (answer || '')}
            onChange={(event) => onTextChange(node.id, event.target.value)}
            placeholder="Enter your answer…"
            disabled={isDisabled}
          />
          <button
            type="button"
            className="pt-soft-button"
            onClick={() => onTextSubmit(node.id)}
            disabled={isDisabled || !(textInputVal || '').trim()}
          >
            Confirm
          </button>
        </div>
      ) : (
        <div className="pt-choice-list" role="group" aria-label={`Answer for question ${index + 1}`}>
          {choices.map((choice) => (
            <button
              key={`${node.id}-${choice}`}
              type="button"
              className={`pt-choice ${String(answer) === String(choice) ? 'is-selected' : ''}`}
              onClick={() => onAnswer(node.id, choice)}
              aria-pressed={String(answer) === String(choice)}
              disabled={isDisabled}
            >
              {choice}
            </button>
          ))}
        </div>
      )}

      {isAnswered && nodeActions.length > 0 && (
        <div className="pt-action-note">
          <strong>Related actions</strong>
          <ul>{nodeActions.map((action, actionIndex) => <li key={`${node.id}-action-${actionIndex}`}>{action}</li>)}</ul>
        </div>
      )}
    </article>
  );
});

/* =========================================================================
   Main App Component
   ========================================================================= */

export default function App() {
  const [file, setFile] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [isDocx, setIsDocx] = useState(false);
  const [treeData, setTreeData] = useState(null);
  const [answers, setAnswers] = useState({});
  const [textInputs, setTextInputs] = useState({});
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [leftWidth, setLeftWidth] = useState(46);
  const [isResizing, setIsResizing] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [textScale, setTextScale] = useState(100);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [dragActive, setDragActive] = useState(false);

  const containerRef = useRef(null);
  const fileInputRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  // Optimized resize handling using requestAnimationFrame to eliminate layout lag
  useEffect(() => {
    if (!isResizing) return undefined;

    const handlePointerMove = (event) => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        if (!rect.width) return;
        const percent = ((event.clientX - rect.left) / rect.width) * 100;
        setLeftWidth(Math.max(28, Math.min(68, percent)));
      });
    };

    const stopResize = () => {
      setIsResizing(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isResizing]);

  const questionNodes = useMemo(() => sortNodeEntries(treeData?.nodes), [treeData]);
  const answeredCount = questionNodes.filter((node) => {
    const value = answers[node.id];
    return value !== undefined && value !== null && String(value).trim() !== '';
  }).length;
  const progress = questionNodes.length ? (answeredCount / questionNodes.length) * 100 : 0;

  const chooseFile = useCallback((selectedFile) => {
    if (!selectedFile) return;
    const lowerName = selectedFile.name.toLowerCase();
    if (!lowerName.endsWith('.pdf') && !lowerName.endsWith('.docx')) {
      setErrorMessage('Choose a PDF or DOCX file.');
      return;
    }

    setErrorMessage('');
    setStatusMessage('');
    setFile(selectedFile);
    setPdfUrl(URL.createObjectURL(selectedFile));
    setIsDocx(lowerName.endsWith('.docx'));
    setZoomLevel(100);
    setTreeData(null);
    setAnswers({});
    setTextInputs({});
  }, []);

  const handleFileChange = useCallback((event) => {
    chooseFile(event.target.files?.[0]);
    event.target.value = '';
  }, [chooseFile]);

  const handleUpload = useCallback(async () => {
    if (!file || loading) return;
    setLoading(true);
    setErrorMessage('');
    setStatusMessage('Reading document…');

    const formData = new FormData();
    formData.append('files', file);

    try {
      const response = await axios.post(`${API_BASE}/parse-pdf`, formData);
      setTreeData(response.data);
      setAnswers({});
      setTextInputs({});
      const count = Object.keys(response.data?.nodes || {}).length;
      setStatusMessage(count
        ? `Ready to review · ${count} source-linked question${count === 1 ? '' : 's'}`
        : 'Text extracted, but no questions passed verification.');
    } catch (error) {
      console.error('PaperTrace document parsing failed:', error);
      const detail = error.response?.data?.detail;
      setErrorMessage(
        typeof detail === 'string'
          ? detail
          : 'Could not parse this document. Check that the FastAPI backend and Ollama are running, then try again.'
      );
      setStatusMessage('');
    } finally {
      setLoading(false);
    }
  }, [file, loading]);

  const handleAnswer = useCallback((nodeId, answer) => {
    setAnswers((previous) => ({ ...previous, [nodeId]: answer }));
    setErrorMessage('');
  }, []);

  const handleTextChange = useCallback((nodeId, value) => {
    setTextInputs((previous) => ({ ...previous, [nodeId]: value }));
  }, []);

  const handleTextInputSubmit = useCallback((nodeId) => {
    const value = textInputs[nodeId];
    if (!value || !value.trim()) return;
    handleAnswer(nodeId, value.trim());
  }, [textInputs, handleAnswer]);

  const resetReview = useCallback(() => {
    setTreeData(null);
    setAnswers({});
    setTextInputs({});
    setErrorMessage('');
    setStatusMessage('');
    setShowModal(false);
  }, []);

  const downloadReport = useCallback(async () => {
    if (!treeData) {
      setErrorMessage('Parse a document before exporting a report.');
      return;
    }

    setErrorMessage('');
    setStatusMessage('Preparing review report…');
    try {
      const response = await axios.post(
        `${API_BASE}/generate-filled-pdf`,
        { answers, nodes: treeData.nodes || {} },
        { responseType: 'blob' }
      );
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'PaperTrace_Review_Report.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setStatusMessage('Review report downloaded. The original document is unchanged.');
    } catch (error) {
      console.error('PaperTrace report generation failed:', error);
      setErrorMessage('Could not generate the report. Check that the FastAPI backend is running.');
      setStatusMessage('');
    }
  }, [treeData, answers]);

  const actions = useMemo(() => questionNodes.flatMap((node) => getNodeActions(node, answers[node.id])), [questionNodes, answers]);
  const uniqueActions = useMemo(() => [...new Set(actions)], [actions]);

  return (
    <div
      className="pt-app"
      data-text-scale={textScale}
      data-material="balanced"
    >
      <Header textScale={textScale} setTextScale={setTextScale} />

      <main
        className="pt-main"
        ref={containerRef}
        style={{ '--pt-left-width': `${leftWidth}%` }}
      >
        <div className="pt-left-column">
          <section className={`pt-intro ${dragActive ? 'pt-intro--dragging' : ''}`}>
            <span className="pt-header-spark" aria-hidden="true">✦ </span>
            <span> A clearer way through complex documents</span>
            
            <h1>Read the requirement. Keep your footing.</h1>
            <p className="pt-lead">All questions in one list. Source stays visible.</p>

            <UploadSection
              file={file}
              loading={loading}
              dragActive={dragActive}
              setDragActive={setDragActive}
              fileInputRef={fileInputRef}
              chooseFile={chooseFile}
              handleFileChange={handleFileChange}
              handleUpload={handleUpload}
            />

            {file && (
              <div className="pt-selected-file">
                <FileText size={17} aria-hidden="true" />
                <span className="pt-selected-filename" title={file.name}>{file.name}</span>
                <span className="pt-file-size">
                  {file.size < 1024 * 1024
                    ? `${Math.max(1, Math.round(file.size / 1024))} KB`
                    : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
                </span>
                <button type="button" className="pt-icon-button" onClick={() => { setFile(null); setPdfUrl(null); setIsDocx(false); resetReview(); }} aria-label="Remove selected document">
                  <X size={15} />
                </button>
              </div>
            )}

            <div className="pt-file-hint">
              <span className="pt-status-dot" aria-hidden="true" />
              <span>PDF or DOCX · Up to 15 MB</span>
            </div>
            
            {treeData && (
              <section className="pt-review">
                <div className="pt-section-heading">
                  <div>
                    <h2>Review questions</h2>
                    <p className="pt-muted">All questions in one list. Check the source before deciding.</p>
                  </div>
                  <button className="pt-text-button" type="button" onClick={resetReview}>
                    <RotateCcw size={14} /> Start over
                  </button>
                </div>

                <div className="pt-progress-area">
                  <div className="pt-progress-label">
                    <span>{answeredCount} of {questionNodes.length} answered</span>
                    <span>{Math.round(progress)}%</span>
                  </div>
                  <div className="pt-progress-track" role="progressbar" aria-label="Questions answered" aria-valuemin="0" aria-valuemax={questionNodes.length || 1} aria-valuenow={answeredCount}>
                    <span style={{ width: `${progress}%` }} />
                  </div>
                </div>

                <div className="pt-question-list">
                  {questionNodes.map((node, index) => (
                    <QuestionCard
                      key={node.id}
                      node={node}
                      index={index}
                      answer={answers[node.id]}
                      textInputVal={textInputs[node.id]}
                      onTextChange={handleTextChange}
                      onTextSubmit={handleTextInputSubmit}
                      onAnswer={handleAnswer}
                      answers={answers}
                    />
                  ))}
                </div>

                <section className="pt-results">
                  <div className="pt-results-heading">
                    <h3>Review summary</h3>
                    <span>{answeredCount} saved</span>
                  </div>
                  {uniqueActions.length > 0 && (
                    <div className="pt-action-summary">
                      <strong>Actions from your answers</strong>
                      <ul>{uniqueActions.map((action, index) => <li key={`summary-action-${index}`}>{action}</li>)}</ul>
                    </div>
                  )}
                  {answeredCount > 0 && (
                    <button className="pt-soft-button pt-details-button" type="button" onClick={() => setShowModal(true)}>
                      <Eye size={16} /> View answer details
                    </button>
                  )}
                  <button className="pt-glass-button pt-report-button" type="button" onClick={downloadReport}>
                    <Download size={17} /> Download review report
                  </button>
                </section>
              </section>
            )}

            {errorMessage && (
              <div className="pt-alert pt-alert--error" role="alert">
                <AlertCircle size={17} />
                <span>{errorMessage}</span>
              </div>
            )}
            {statusMessage && (
              <div className="pt-status-message" role="status" aria-live="polite">
                {statusMessage}
              </div>
            )}
          </section>
        </div>

        <div
          className={`pt-divider ${isResizing ? 'pt-divider--active' : ''}`}
          role="separator"
          aria-label="Resize review and document panels"
          aria-orientation="vertical"
          aria-valuemin="28"
          aria-valuemax="68"
          aria-valuenow={Math.round(leftWidth)}
          tabIndex={0}
          onPointerDown={(event) => { event.preventDefault(); setIsResizing(true); }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setLeftWidth((value) => Math.max(28, value - 3));
            if (event.key === 'ArrowRight') setLeftWidth((value) => Math.min(68, value + 3));
            if (event.key === 'Home') setLeftWidth(28);
            if (event.key === 'End') setLeftWidth(68);
            if (event.key === 'Enter') setLeftWidth(46);
          }}
          title="Drag to resize. Use arrow keys to adjust; Enter resets."
        >
          <span />
        </div>

        <section className="pt-workspace" aria-label="Original document preview">
          <div className="pt-panel-head">
            <div>
              <h2>Original document</h2>
              <p className="pt-panel-caption">{file ? file.name : 'Your source stays visible here.'}</p>
            </div>
            {!isDocx && file && (
              <div className="pt-zoom-controls" aria-label="PDF zoom controls">
                <button className="pt-icon-button" type="button" onClick={() => setZoomLevel((value) => Math.max(50, value - 15))} aria-label="Zoom out">
                  <ZoomOut size={16} />
                </button>
                <span>{zoomLevel}%</span>
                <button className="pt-icon-button" type="button" onClick={() => setZoomLevel((value) => Math.min(250, value + 15))} aria-label="Zoom in">
                  <ZoomIn size={16} />
                </button>
                <button className="pt-text-button" type="button" onClick={() => setZoomLevel(100)}>Reset</button>
              </div>
            )}
          </div>

          <div className="pt-document-frame">
            <div className="pt-document-toolbar">
              <span className="pt-toolbar-filename">{file ? file.name : 'PREVIEW WILL APPEAR HERE'}</span>
              {file && <span className="pt-toolbar-state">Local preview</span>}
            </div>
            <div className="pt-document-body">
              {!file ? (
                <div className="pt-preview-empty">
                  <div className="pt-empty-icon"><FileText size={26} /></div>
                  <h3>Your document appears here.</h3>
                  <p>Choose a PDF or DOCX to keep the original beside your review.</p>
                </div>
              ) : isDocx ? (
                <div className="pt-docx-preview">
                  {treeData?.text_preview || 'Click “Start review” to extract the Word document text.'}
                </div>
              ) : (
                <iframe
                  key={`${pdfUrl}-${zoomLevel}`}
                  src={`${pdfUrl}#zoom=${zoomLevel}&toolbar=0`}
                  title="PDF source preview"
                  className="pt-pdf-frame"
                />
              )}
            </div>
          </div>
        </section>
      </main>

      {showModal && (
        <div className="pt-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowModal(false); }}>
          <section className="pt-modal" role="dialog" aria-modal="true" aria-labelledby="pt-modal-title">
            <header className="pt-modal-heading">
              <div>
                <p className="pt-eyebrow">PaperTrace</p>
                <h2 id="pt-modal-title">Answer details</h2>
              </div>
              <button type="button" className="pt-icon-button" onClick={() => setShowModal(false)} aria-label="Close details"><X size={17} /></button>
            </header>
            <p className="pt-muted">{treeData?.document_title || file?.name}. Answers shown here are your selections, not a compliance certification.</p>
            <div className="pt-modal-list">
              {questionNodes.map((node, index) => (
                <article key={`modal-${node.id}`} className="pt-modal-item">
                  <h3>{index + 1}. {node.question}</h3>
                  <blockquote>{node.source_excerpt || 'No source excerpt.'}</blockquote>
                  <p><strong>Answer:</strong> {answers[node.id] === undefined ? 'Not answered' : String(answers[node.id])}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}