import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Search, HelpCircle, Download, RotateCcw, ZoomIn, ZoomOut, X } from 'lucide-react';

export default function App() {
  const [file, setFile] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [treeData, setTreeData] = useState(null);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(false);
  const [highlightedNode, setHighlightedNode] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [textInputs, setTextInputs] = useState({});

  // Resizable split state & Zoom state (starts at 100%)
  const [leftWidth, setLeftWidth] = useState(50); // percentage
  const [isResizing, setIsResizing] = useState(false);
  const [hasResized, setHasResized] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);

  const containerRef = useRef(null);

  const handleFileChange = (e) => {
    const uploadedFiles = e.target.files;
    if (uploadedFiles && uploadedFiles.length > 0) {
      setFile(uploadedFiles[0]);
      setPdfUrl(URL.createObjectURL(uploadedFiles[0]));
      setZoomLevel(100);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    const formData = new FormData();
    formData.append("files", file);

    try {
      const res = await axios.post("http://localhost:8000/parse-pdf", formData);
      setTreeData(res.data);
      setAnswers({});
      setTextInputs({});
    } catch (err) {
      alert("Failed to parse PDF batch. Ensure backend is running.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleAnswer = (nodeId, answer) => {
    setAnswers({ ...answers, [nodeId]: answer });
  };

  const handleTextInputSubmit = (nodeId, nextTarget) => {
    const val = textInputs[nodeId];
    if (!val || !val.trim()) return;
    setAnswers({ ...answers, [nodeId]: val.trim() });
  };

  // Resizer mouse handlers
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizing) return;
      const totalWidth = window.innerWidth;
      const newLeftWidth = (e.clientX / totalWidth) * 100;
      if (newLeftWidth > 20 && newLeftWidth < 80) {
        setLeftWidth(newLeftWidth);
        if (newLeftWidth !== 50) setHasResized(true);
      }
    };
    const handleMouseUp = () => {
      setIsResizing(false);
    };
    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Dynamic Tree Traversal supporting multi-choices & text inputs
  const getActiveSequence = () => {
    if (!treeData || !treeData.nodes || !treeData.start_node) return [];
    const sequence = [];
    let currentId = treeData.start_node;

    while (currentId && treeData.nodes[currentId]) {
      const node = treeData.nodes[currentId];
      sequence.push({ id: currentId, ...node });

      const ans = answers[currentId];
      if (ans === undefined) break;

      if (node.response_type === 'text') {
        currentId = node.next_target;
      } else if (node.targets && node.targets[ans]) {
        currentId = node.targets[ans];
      } else if (ans === 'Yes') {
        currentId = node.yes_target;
      } else if (ans === 'No') {
        currentId = node.no_target;
      } else {
        break;
      }
    }
    return sequence;
  };

  const activeSequence = getActiveSequence();

  const lastActiveNode = activeSequence[activeSequence.length - 1];
  const isBranchTerminal = lastActiveNode && answers[lastActiveNode.id] !== undefined && (
    (lastActiveNode.response_type === 'choice' && lastActiveNode.targets && !lastActiveNode.targets[answers[lastActiveNode.id]]) ||
    (lastActiveNode.response_type === 'text' && !lastActiveNode.next_target) ||
    (answers[lastActiveNode.id] === 'Yes' && !lastActiveNode.yes_target) || 
    (answers[lastActiveNode.id] === 'No' && !lastActiveNode.no_target)
  );

  const activeActionItems = [];
  activeSequence.forEach(node => {
    if (answers[node.id] && node.action_items) {
      activeActionItems.push(...node.action_items);
    }
  });

  const downloadReport = async () => {
    try {
      const res = await axios.post("http://localhost:8000/generate-filled-pdf", {
        answers,
        nodes: treeData?.nodes || {}
      }, { responseType: 'blob' });

      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'Master_Compliance_Report.pdf');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      alert("Failed to download PDF report!");
    }
  };

  return (
    <div className="h-screen bg-white text-black flex flex-col font-serif overflow-hidden">
      {/* Top Navigation Bar with Uniform Thin Borders */}
      <header className="border-b border-black px-6 py-3 grid grid-cols-3 items-center bg-white rounded-none shrink-0">
        <div>
          <h1 className="text-xl font-bold tracking-wide">PaperTrace</h1>
        </div>
        <div className="flex justify-center">
          <button 
            onClick={handleUpload} 
            disabled={!file || loading} 
            className="border border-black bg-white hover:bg-black hover:text-white px-6 py-1.5 text-sm font-semibold rounded-none transition"
          >
            {loading ? "Parsing PDF..." : "Start Parse"}
          </button>
        </div>
        <div className="flex justify-end items-center space-x-2">
          <label className="border border-black px-3 py-1.5 text-xs font-bold uppercase bg-white hover:bg-black hover:text-white cursor-pointer transition rounded-none">
            Select file(s)
            <input 
              type="file" 
              multiple
              onChange={handleFileChange} 
              className="hidden" 
            />
          </label>
          <span className="text-xs truncate max-w-[150px]">
            {file ? file.name : "No file chosen"}
          </span>
        </div>
      </header>

      {/* Main Split Dashboard */}
      <div className="flex-1 flex overflow-hidden relative min-h-0" ref={containerRef}>
        
        {/* Left Column: Questions List */}
        <div 
          className="p-6 overflow-y-auto space-y-6 bg-white h-full"
          style={{ width: `${leftWidth}%` }}
        >
          {!treeData ? (
            <div className="flex flex-col items-center justify-center h-full text-black space-y-3">
              <p>Upload a compliance PDF and click "Start Parse" to begin review.</p>
            </div>
          ) : (
            <>
              <div className="border border-black p-4 rounded-none bg-white flex justify-between items-center">
                <div>
                  <span className="text-xs uppercase tracking-wider font-bold">Active Document</span>
                  <h2 className="text-lg font-bold">{treeData.document_title}</h2>
                </div>
                <button 
                  onClick={() => { setAnswers({}); setTextInputs({}); }} 
                  className="border border-black px-3 py-1 text-xs font-bold hover:bg-black hover:text-white rounded-none flex items-center space-x-1 transition"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> <span>Reset</span>
                </button>
              </div>

              {activeSequence.map((node, index) => {
                const isAnswered = answers[node.id] !== undefined;
                const choices = node.choices || (node.response_type === 'choice' ? Object.keys(node.targets || {}) : ['Yes', 'No']);

                return (
                  <div key={node.id} className="border border-black rounded-none p-5 bg-white space-y-3">
                    <div className="flex justify-between items-start">
                      <span className="text-xs font-bold tracking-wider flex items-center space-x-2">
                        <span>ITEM #{index + 1}</span>
                        {isAnswered && <span className="border border-black px-1.5 py-0.5 text-xs font-bold bg-black text-white">✓ Answered ({answers[node.id]})</span>}
                      </span>
                      
                      <button 
                        onClick={() => setHighlightedNode(node.id)}
                        title="Locate source in PDF"
                        className="border border-black p-1.5 bg-white hover:bg-black hover:text-white rounded-none flex items-center space-x-1 transition"
                      >
                        <Search className="w-4 h-4 inline" />
                        <HelpCircle className="w-4 h-4 inline" />
                      </button>
                    </div>

                    <p className="text-lg font-medium">{node.question}</p>

                    <div className="border-l-2 border-black pl-4 py-1 text-sm italic">
                      "{node.source_excerpt || node.question}"
                    </div>

                    {node.response_type === 'text' ? (
                      <div className="space-y-3 pt-2">
                        <input 
                          type="text" 
                          placeholder="Type your official response for form blank..."
                          value={textInputs[node.id] !== undefined ? textInputs[node.id] : (answers[node.id] || '')}
                          onChange={(e) => setTextInputs({ ...textInputs, [node.id]: e.target.value })}
                          className="w-full border border-black p-2.5 text-sm rounded-none focus:outline-none bg-white"
                        />
                        <button
                          onClick={() => handleTextInputSubmit(node.id, node.next_target)}
                          className="border border-black bg-white hover:bg-black hover:text-white px-4 py-2 font-bold text-xs uppercase transition rounded-none"
                        >
                          Confirm Form Input
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2 pt-2">
                        {choices.map((choice, cIdx) => (
                          <button 
                            key={cIdx}
                            onClick={() => handleAnswer(node.id, choice)}
                            className={`flex-1 min-w-[100px] border border-black py-2.5 px-3 font-bold rounded-none transition ${answers[node.id] === choice ? 'bg-black text-white' : 'bg-white hover:bg-black hover:text-white'}`}
                          >
                            {choice}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {isBranchTerminal && (
                <div className="border border-black p-4 text-xs font-bold uppercase tracking-wider bg-white">
                  ★ EVALUATION COMPLETE FOR THIS BRANCH.
                </div>
              )}

              <div className="border border-black rounded-none p-6 space-y-4 bg-white mt-8">
                <div className="text-base font-bold tracking-wide border-b border-black pb-2">RESULT</div>
                
                <div className="text-sm space-y-3">
                  {Object.keys(answers).length > 0 ? (
                    <>
                      <p className="font-bold">Evaluated {Object.keys(answers).length} item(s) in active compliance path.</p>
                      
                      <div className="flex space-x-3">
                        <button 
                          onClick={() => setShowModal(true)}
                          className="flex-1 border border-black bg-white hover:bg-black hover:text-white font-bold py-2 px-3 rounded-none text-xs uppercase tracking-wider transition"
                        >
                          View Detailed Explanation
                        </button>
                      </div>

                      <div className="border border-black p-3 space-y-2 bg-white">
                        <p className="font-bold text-xs uppercase tracking-wider">Required Compliance Actions & Explanations:</p>
                        {activeActionItems.length > 0 ? (
                          <ul className="list-disc pl-5 space-y-1">
                            {Array.from(new Set(activeActionItems)).map((action, i) => (
                              <li key={i}>{action}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="italic">No further action required based on your current path selections.</p>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="italic">Awaiting user decisions on active compliance checklist items above...</p>
                  )}
                </div>

                <button 
                  onClick={downloadReport}
                  className="w-full border border-black bg-white hover:bg-black hover:text-white font-bold py-3 px-4 rounded-none flex items-center justify-center space-x-2 transition mt-4"
                >
                  <Download className="w-5 h-5" />
                  <span>Download Report File</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Resizable Divider Bar */}
        <div 
          onMouseDown={() => setIsResizing(true)}
          className="w-4 bg-white cursor-col-resize z-10 relative select-none flex items-center justify-center shrink-0"
          title="Drag to resize panels"
        >
          <div className="absolute inset-y-0 left-0 w-[1px] bg-black" />
          <div className="absolute inset-y-0 right-0 w-[1px] bg-black" />
          {isResizing && (
            <div className="absolute inset-y-0 left-1/2 w-[1px] bg-black -translate-x-1/2" />
          )}

          {hasResized && (
            <button 
              onClick={(e) => { 
                e.stopPropagation(); 
                setLeftWidth(50); 
                setHasResized(false); 
              }}
              className="absolute top-4 border border-black p-1 bg-white hover:bg-black hover:text-white rounded-none transition z-20"
              title="Reset panel sizing (50/50)"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Right Column: Interactive Live PDF Source Document Viewer */}
        <div 
          className="bg-white flex flex-col h-full relative overflow-hidden px-4 py-3 min-h-0"
          style={{ width: `${100 - leftWidth}%` }}
        >
          <div className="flex justify-between items-center mb-2 shrink-0">
            <span className="text-xs uppercase tracking-wider font-bold">LIVE PDF SOURCE DOCUMENT VIEWER</span>
            <div className="flex items-center space-x-1">
              <button 
                onClick={() => setZoomLevel(prev => Math.max(50, prev - 15))}
                className="border border-black p-1 bg-white hover:bg-black hover:text-white rounded-none"
                title="Zoom Out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-xs font-bold px-1">{zoomLevel}%</span>
              <button 
                onClick={() => setZoomLevel(prev => Math.min(250, prev + 15))}
                className="border border-black p-1 bg-white hover:bg-black hover:text-white rounded-none"
                title="Zoom In"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button 
                onClick={() => setZoomLevel(100)}
                className="border border-black px-2 py-0.5 text-xs font-bold hover:bg-black hover:text-white rounded-none ml-1"
              >
                Reset
              </button>
            </div>
          </div>
          
          {/* Iframe container */}
          <div className="flex-1 bg-white rounded-none border border-black relative overflow-hidden flex flex-col min-h-0">
            {pdfUrl ? (
              <div className="relative w-full h-full flex-1 min-h-0">
                <iframe 
                  key={zoomLevel}
                  src={`${pdfUrl}#zoom=${zoomLevel}&toolbar=0`}
                  className="w-full h-full border-0 absolute inset-0"
                  title="PDF Preview" 
                />

                {/* Dismissible Highlight Box / Notice Banner */}
                {highlightedNode && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black text-white px-4 py-2 text-xs font-bold flex items-center space-x-3 shadow-lg z-30 rounded-none border border-black">
                    <span>⚡ Source Excerpt Highlight Active for Item</span>
                    <button 
                      onClick={() => setHighlightedNode(null)}
                      className="border border-white p-0.5 hover:bg-white hover:text-black transition"
                      title="Dismiss Highlight"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {highlightedNode && (
                  <div className="absolute top-20 left-1/2 -translate-x-1/2 w-3/4 h-24 border-2 border-orange-500 bg-orange-100/30 pointer-events-none z-20" />
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full space-y-2">
                <p className="text-sm">No PDF loaded for preview</p>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Enlarged Brutalist Pop-up Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6">
          <div className="bg-white border-2 border-black p-8 w-full max-w-4xl max-h-[90vh] overflow-y-auto space-y-6 rounded-none shadow-2xl">
            <div className="flex justify-between items-center border-b-2 border-black pb-4">
              <h3 className="text-lg font-bold tracking-wide uppercase">Compliance Evaluation Detailed Breakdown</h3>
              <button 
                onClick={() => setShowModal(false)}
                className="border border-black px-4 py-1.5 text-sm font-bold hover:bg-black hover:text-white rounded-none transition"
              >
                [CLOSE]
              </button>
            </div>

            <div className="space-y-6 text-base">
              <div>
                <span className="text-sm uppercase font-bold text-gray-700">Document Source:</span>
                <p className="font-bold text-lg mt-0.5">{treeData?.document_title}</p>
              </div>

              <div className="border-2 border-black p-6 space-y-6 bg-gray-50/50">
                <p className="font-bold text-sm uppercase tracking-wider text-black">
                  Traversed Path Summary ({activeSequence.length} Questions):
                </p>
                {activeSequence.map((node, i) => (
                  <div key={node.id} className="border-b-2 border-black/30 pb-6 last:border-0 last:pb-0 space-y-3">
                    <p className="text-base font-medium"><b>Question {i + 1}:</b> {node.question}</p>
                    <p className="text-sm italic text-gray-800">Source Excerpt: "{node.source_excerpt}"</p>
                    <p className="text-base"><b>User Decision:</b> <span className="underline font-bold text-lg">{answers[node.id]}</span></p>

                    {node.action_items && node.action_items.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-black/30">
                        <p className="font-bold text-sm uppercase tracking-wider">Required Action Item(s):</p>
                        <ul className="list-disc pl-6 text-sm space-y-2 mt-1">
                          {node.action_items.map((action, actIdx) => (
                            <li key={actIdx} className="text-base">{action}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}