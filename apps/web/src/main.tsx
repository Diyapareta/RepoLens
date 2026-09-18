import { FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./rag.css";

type Ingestion = {
  repository: { owner: string; name: string; branch: string; description: string | null; language: string | null; stars: number; url: string };
  files: { path: string; size: number; url: string }[];
  ignoredCount: number;
  truncated: boolean;
};

type Preparation = {
  processedFiles: number;
  chunks: { id: string; path: string; startLine: number; endLine: number; content: string }[];
};
type IndexResult = { indexedChunks: number; processedFiles: number };
type Answer = { answer: string; sources: { path: string; startLine: number; endLine: number }[] };

function App() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<Ingestion | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<Preparation | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexed, setIndexed] = useState<IndexResult | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);

  async function ingest(event: FormEvent) {
    event.preventDefault();
    setError(""); setResult(null); setPrepared(null); setIndexed(null); setAnswer(null); setLoading(true);
    try {
      const response = await fetch("http://localhost:4000/api/repositories/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Something went wrong.");
      setResult(data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not connect to the API.");
    } finally { setLoading(false); }
  }

  async function prepare() {
    setError(""); setPreparing(true);
    try {
      const response = await fetch("http://localhost:4000/api/repositories/prepare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not prepare the repository.");
      setPrepared(data);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not connect to the API."); }
    finally { setPreparing(false); }
  }

  async function buildIndex() {
    setError(""); setIndexing(true);
    try {
      const response = await fetch("http://localhost:4000/api/repositories/index", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not build the AI index.");
      setIndexed(data);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not connect to the API."); }
    finally { setIndexing(false); }
  }

  async function ask(event: FormEvent) {
    event.preventDefault(); if (!question.trim()) return;
    setError(""); setAsking(true); setAnswer(null);
    try {
      const response = await fetch("http://localhost:4000/api/questions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, question }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not answer this question.");
      setAnswer(data);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not connect to the API."); }
    finally { setAsking(false); }
  }

  return <main>
    <nav><div className="brand"><span>◈</span> RepoLens</div><div className="badge">MVP · public repos</div></nav>
    <section className="hero">
      <p className="eyebrow">AI-POWERED CODE EXPLORATION</p>
      <h1>Understand a codebase<br /><em>before you open it.</em></h1>
      <p className="intro">Paste a public GitHub repository to map its useful files. Next, RepoLens will turn this map into an answerable codebase.</p>
      <form onSubmit={ingest}>
        <input aria-label="GitHub repository URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" />
        <button disabled={loading}>{loading ? "Inspecting…" : "Analyze repository"}</button>
      </form>
      {error && <p className="error">{error}</p>}
      <p className="hint">Works with public GitHub repositories only. No sign-in needed.</p>
    </section>
    {result ? <section className="result">
      <div className="repo-head"><div><p className="eyebrow">REPOSITORY READY FOR INDEXING</p><h2>{result.repository.owner} <span>/</span> {result.repository.name}</h2><p>{result.repository.description ?? "No description provided."}</p></div><a href={result.repository.url} target="_blank" rel="noreferrer">View on GitHub ↗</a></div>
      <div className="stats"><div><strong>{result.files.length}</strong><span>eligible files</span></div><div><strong>{result.ignoredCount}</strong><span>filtered files</span></div><div><strong>{result.repository.language ?? "Mixed"}</strong><span>primary language</span></div><div><strong>★ {result.repository.stars}</strong><span>GitHub stars</span></div></div>
      <div className="file-panel"><div className="panel-title"><span>File map</span><small>branch: {result.repository.branch}</small></div><ul>{result.files.slice(0, 18).map((file) => <li key={file.path}><span className="file-icon">⌘</span><a href={file.url} target="_blank" rel="noreferrer">{file.path}</a><small>{Math.max(1, Math.ceil(file.size / 1024))} KB</small></li>)}</ul>{result.files.length > 18 && <p className="more">+ {result.files.length - 18} more files ready for the next step</p>}</div>
      <div className="next"><span>02</span><div><strong>Prepare the knowledge base</strong><p>Download the first 100 eligible files and split them into meaningful, line-traceable code chunks.</p>{!prepared && <button className="prepare" onClick={prepare} disabled={preparing}>{preparing ? "Preparing chunks…" : "Prepare code chunks"}</button>}</div></div>
      {prepared && <div className="prepared"><p className="eyebrow">CODE PREP COMPLETE</p><h3>{prepared.chunks.length} chunks from {prepared.processedFiles} files</h3><p>Every chunk remembers its exact file and line range, which is how future AI answers will cite sources.</p><div className="chunk-sample"><small>{prepared.chunks[0]?.path}:{prepared.chunks[0]?.startLine}–{prepared.chunks[0]?.endLine}</small><pre>{prepared.chunks[0]?.content}</pre></div></div>}
      {prepared && !indexed && <button className="index" onClick={buildIndex} disabled={indexing}>{indexing ? "Creating AI index…" : "Build AI index"}</button>}
      {indexed && <section className="chat"><p className="eyebrow">ASK YOUR CODEBASE</p><h3>Knowledge base ready · {indexed.indexedChunks} chunks indexed</h3><form onSubmit={ask}><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="How does authentication work?" /><button disabled={asking}>{asking ? "Thinking…" : "Ask"}</button></form>{answer && <div className="answer"><p>{answer.answer}</p><strong>Sources</strong><ul>{answer.sources.map((source) => <li key={`${source.path}:${source.startLine}`}><span className="file-icon">⌘</span>{source.path}:{source.startLine}–{source.endLine}</li>)}</ul></div>}</section>}
    </section> : <section className="preview"><div className="preview-mark">⌘</div><div><p className="eyebrow">THE FIRST STEP</p><h2>A focused file map, not noise.</h2><p>Dependencies, generated output, oversized files, and binaries are excluded so later answers stay relevant.</p></div><div className="filters"><span>Source code</span><span>Docs</span><span>Config</span></div></section>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
