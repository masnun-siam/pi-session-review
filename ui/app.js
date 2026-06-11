import { h, render } from "https://esm.sh/preact@10.19.3";
import { useState, useEffect, useRef, useCallback, useMemo } from "https://esm.sh/preact@10.19.3/hooks";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(h);

function App() {
  const [files, setFiles] = useState([]); // [{path, status, added, removed}]
  const [selectedFile, setSelectedFile] = useState(null);
  const [review, setReview] = useState({
    comments: [],
    preferences: { viewMode: "split" },
  });
  const [diff, setDiff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [commentingLine, setCommentingLine] = useState(null); // `${file}:${idx}`
  const [commentText, setCommentText] = useState("");
  const [focusedLine, setFocusedLine] = useState(0);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [toast, setToast] = useState(null);

  const filesRef = useRef(files);
  const selectedFileRef = useRef(selectedFile);
  const diffRef = useRef(diff);
  const focusedLineRef = useRef(focusedLine);
  const reviewRef = useRef(review);
  const commentingRef = useRef(commentingLine);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);
  useEffect(() => { diffRef.current = diff; }, [diff]);
  useEffect(() => { focusedLineRef.current = focusedLine; }, [focusedLine]);
  useEffect(() => { reviewRef.current = review; }, [review]);
  useEffect(() => { commentingRef.current = commentingLine; }, [commentingLine]);

  // ── initial load ───────────────────────────────────────
  useEffect(() => {
    (async () => {
      await Promise.all([loadReview(), loadFiles()]);
      setLoading(false);
    })();

    // SSE: live refresh on filesystem changes
    let es;
    try {
      es = new EventSource("/api/events");
      es.addEventListener("files-changed", () => {
        loadFiles();
        if (selectedFileRef.current) loadDiff(selectedFileRef.current);
      });
      es.onerror = () => { /* let browser auto-retry */ };
    } catch {}
    return () => { try { es && es.close(); } catch {} };
  }, []);

  // ── data fetchers ──────────────────────────────────────
  async function loadReview() {
    try {
      const res = await fetch("/api/review");
      const data = await res.json();
      const prefs = data.preferences || {};
      setReview({
        ...data,
        preferences: { viewMode: prefs.viewMode === "unified" ? "unified" : "split" },
      });
    } catch (err) { console.error("review load:", err); }
  }

  async function loadFiles() {
    try {
      const res = await fetch("/api/files");
      const data = await res.json();
      const list = data.files || [];
      setFiles(list);
      // keep selection if still present; otherwise pick first
      const stillThere = list.find((f) => f.path === selectedFileRef.current);
      if (!stillThere && list.length) {
        setSelectedFile(list[0].path);
      } else if (!list.length) {
        setSelectedFile(null);
        setDiff([]);
      }
    } catch (err) { console.error("files load:", err); }
  }

  async function loadDiff(file) {
    try {
      const res = await fetch(`/api/diff?file=${encodeURIComponent(file)}`);
      const data = await res.json();
      setDiff(data.lines || []);
      setFocusedLine(0);
    } catch (err) { console.error("diff load:", err); }
  }

  useEffect(() => { if (selectedFile) loadDiff(selectedFile); }, [selectedFile]);

  // ── persistence helpers ────────────────────────────────
  async function persistReview(next) {
    setReview(next);
    try {
      await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
    } catch (err) { console.error("review save:", err); }
  }

  function setViewMode(mode) {
    persistReview({
      ...reviewRef.current,
      preferences: { ...reviewRef.current.preferences, viewMode: mode },
    });
  }

  async function saveComment(file, line, content) {
    const newComment = {
      id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file, line, content,
      createdAt: new Date().toISOString(),
      status: "pending",
      sentAt: null,
      piResponse: null,
    };
    await persistReview({
      ...reviewRef.current,
      comments: [...reviewRef.current.comments, newComment],
    });
    setCommentingLine(null);
    setCommentText("");
  }

  async function updateComment(id, content) {
    await persistReview({
      ...reviewRef.current,
      comments: reviewRef.current.comments.map((c) =>
        c.id === id ? { ...c, content } : c,
      ),
    });
    setEditingId(null);
    setEditText("");
  }

  async function deleteComment(id) {
    await persistReview({
      ...reviewRef.current,
      comments: reviewRef.current.comments.filter((c) => c.id !== id),
    });
  }

  async function sendToPi() {
    try {
      const res = await fetch("/api/send", { method: "POST" });
      const data = await res.json();
      if (data.sent > 0) {
        flashToast(`Sent ${data.sent} comment${data.sent === 1 ? "" : "s"} to pi`);
        await loadReview();
      } else {
        flashToast("Nothing to send");
      }
    } catch (err) {
      console.error("send:", err);
      flashToast("Send failed");
    }
  }

  function flashToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }

  function getCommentsForLine(file, line) {
    return review.comments.filter((c) => c.file === file && c.line === line);
  }

  // ── keyboard navigation ────────────────────────────────
  const jumpToHunk = useCallback((dir) => {
    const d = diffRef.current;
    if (!d.length) return;
    const cur = focusedLineRef.current;
    const isHunk = (i) => d[i] && (d[i].type === "added" || d[i].type === "removed" || d[i].type === "header");
    let i = cur + dir;
    while (i >= 0 && i < d.length && !isHunk(i)) i += dir;
    if (i >= 0 && i < d.length) {
      setFocusedLine(i);
      scrollFocusedIntoView();
    }
  }, []);

  function scrollFocusedIntoView() {
    requestAnimationFrame(() => {
      const el = document.querySelector(".diff-line.is-focused");
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  useEffect(() => {
    function onKey(e) {
      // ignore when typing in any input/textarea
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input") {
        if (e.key === "Escape") {
          e.target.blur();
          setCommentingLine(null);
          setEditingId(null);
        }
        return;
      }
      // global shortcuts
      const f = filesRef.current;
      const idx = f.findIndex((x) => x.path === selectedFileRef.current);

      if (e.key === "j") {
        if (idx < f.length - 1) setSelectedFile(f[idx + 1].path);
      } else if (e.key === "k") {
        if (idx > 0) setSelectedFile(f[idx - 1].path);
      } else if (e.key === "n") {
        jumpToHunk(1);
      } else if (e.key === "p") {
        jumpToHunk(-1);
      } else if (e.key === "c") {
        const file = selectedFileRef.current;
        const line = focusedLineRef.current;
        if (file != null) {
          setCommentingLine(`${file}:${line}`);
          e.preventDefault();
        }
      } else if (e.key === "Escape") {
        setCommentingLine(null);
        setEditingId(null);
      } else if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendToPi();
      } else if (e.key === "?") {
        flashToast("j/k files · n/p hunks · c comment · esc close · ⌘S send");
      } else {
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jumpToHunk]);

  const pendingCount = useMemo(
    () => review.comments.filter((c) => c.status === "pending").length,
    [review.comments],
  );

  const commentsByFile = useMemo(() => {
    const m = new Map();
    for (const c of review.comments) {
      if (!m.has(c.file)) m.set(c.file, 0);
      m.set(c.file, m.get(c.file) + 1);
    }
    return m;
  }, [review.comments]);

  if (loading) return html`<div class="loading">Loading…</div>`;

  return html`
    <div class="app">
      <header class="brand">
        <div class="brand-title"><em>pi</em><span class="dot">.</span> <em>review</em></div>
        <div class="brand-sub">Session changes · local</div>
      </header>

      <aside class="sidebar">
        <div class="sidebar-header">
          <span>Files</span>
          <span class="count">${files.length}</span>
        </div>
        ${files.length === 0
          ? html`<div class="sidebar-empty">No changes detected in this working tree.</div>`
          : html`
              <ul class="file-list">
                ${files.map((f) => {
                  const status = statusClass(f.status);
                  const cmt = commentsByFile.get(f.path) || 0;
                  return html`
                    <li
                      class=${`file-item ${selectedFile === f.path ? "active" : ""}`}
                      onClick=${() => setSelectedFile(f.path)}
                      title=${f.path}
                    >
                      <span class=${`file-badge ${status}`}>${f.status || "M"}</span>
                      <span class="file-name">${f.path}</span>
                      <span class="file-stats">
                        ${f.added > 0 ? html`<span class="stat-add">+${f.added}</span>` : null}
                        ${f.removed > 0 ? html`<span class="stat-rem">−${f.removed}</span>` : null}
                        ${cmt > 0 ? html`<span class="stat-cmt" title="comments">${cmt}</span>` : null}
                      </span>
                    </li>
                  `;
                })}
              </ul>
            `}
        <div class="sidebar-foot">
          <kbd>j</kbd><kbd>k</kbd> files · <kbd>n</kbd><kbd>p</kbd> hunks · <kbd>c</kbd> comment · <kbd>?</kbd>
        </div>
      </aside>

      <main class="main-content">
        <div class="toolbar">
          <div class="segmented" role="tablist">
            <button
              class=${review.preferences.viewMode === "split" ? "active" : ""}
              onClick=${() => setViewMode("split")}
            >Split</button>
            <button
              class=${review.preferences.viewMode === "unified" ? "active" : ""}
              onClick=${() => setViewMode("unified")}
            >Unified</button>
          </div>
          <div class="toolbar-spacer"></div>
          <div class="badge">
            <span class="badge-num">${pendingCount}</span>
            <span>pending</span>
          </div>
          <button
            class="send-btn"
            disabled=${pendingCount === 0}
            onClick=${sendToPi}
            title="Send pending comments to pi (⌘S)"
          >
            <span class="send-arrow">↗</span> Send to pi
          </button>
        </div>

        <div class="diff-container">
          ${!selectedFile
            ? html`<div class="empty-state">
                <div>
                  <div class="e-title">Nothing selected.</div>
                  <div class="e-sub">Pick a file to inspect</div>
                </div>
              </div>`
            : html`<${DiffView}
                file=${selectedFile}
                diff=${diff}
                viewMode=${review.preferences.viewMode}
                focusedLine=${focusedLine}
                setFocusedLine=${setFocusedLine}
                onComment=${saveComment}
                onUpdateComment=${updateComment}
                onDeleteComment=${deleteComment}
                getComments=${getCommentsForLine}
                commentingLine=${commentingLine}
                setCommentingLine=${setCommentingLine}
                commentText=${commentText}
                setCommentText=${setCommentText}
                editingId=${editingId}
                setEditingId=${setEditingId}
                editText=${editText}
                setEditText=${setEditText}
              />`}
        </div>
      </main>

      ${toast && html`<div class="toast">${toast}</div>`}
    </div>
  `;
}

function statusClass(s) {
  if (s === "A") return "added";
  if (s === "D") return "deleted";
  return "modified";
}

function DiffView(props) {
  const { file, diff, viewMode } = props;

  return html`
    <div class="diff-file">
      <div class="diff-file-header">
        <span class="marker">§</span>
        <span class="path">${file}</span>
      </div>
      ${viewMode === "split"
        ? html`<${SplitDiff} ...${props} />`
        : html`<${UnifiedDiff} ...${props} />`}
    </div>
  `;
}

// ───────────────── Unified view ─────────────────

function UnifiedDiff({
  file, diff, focusedLine, setFocusedLine,
  onComment, onUpdateComment, onDeleteComment, getComments,
  commentingLine, setCommentingLine, commentText, setCommentText,
  editingId, setEditingId, editText, setEditText,
}) {
  return html`
    <table class="diff-table unified">
      <colgroup>
        <col class="gutter" />
        <col class="gutter" />
        <col class="content" />
      </colgroup>
      <tbody>
        ${diff.map((line, i) => {
          if (line.type === "header") {
            return html`
              <tr key=${`h-${i}`} class=${`diff-line header ${i === focusedLine ? "is-focused" : ""}`}>
                <td colspan="3">${line.content}</td>
              </tr>
            `;
          }
          const key = `${file}:${i}`;
          const isCommenting = commentingLine === key;
          const comments = getComments(file, i);
          const focused = i === focusedLine;
          return html`
            <tr
              key=${i}
              class=${`diff-line ${line.type} ${focused ? "is-focused" : ""}`}
              onClick=${() => setFocusedLine(i)}
            >
              <td
                class="diff-line-num"
                onClick=${(e) => { e.stopPropagation(); setFocusedLine(i); setCommentingLine(isCommenting ? null : key); }}
              >${line.oldNum || ""}</td>
              <td
                class="diff-line-num"
                onClick=${(e) => { e.stopPropagation(); setFocusedLine(i); setCommentingLine(isCommenting ? null : key); }}
              >${line.newNum || ""}</td>
              <td class="diff-line-content">${line.content}</td>
            </tr>
            ${isCommenting &&
              html`<${CommentEditor}
                colspan=${3}
                file=${file}
                line=${i}
                commentText=${commentText}
                setCommentText=${setCommentText}
                onSubmit=${onComment}
                onCancel=${() => setCommentingLine(null)}
              />`}
            ${comments.length > 0 &&
              html`<${CommentList}
                colspan=${3}
                comments=${comments}
                editingId=${editingId}
                editText=${editText}
                setEditingId=${setEditingId}
                setEditText=${setEditText}
                onUpdate=${onUpdateComment}
                onDelete=${onDeleteComment}
              />`}
          `;
        })}
      </tbody>
    </table>
  `;
}

// ───────────────── Split view ─────────────────

function buildSplitRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "header") {
      rows.push({ kind: "header", content: line.content, key: `h-${i}`, anchor: i });
      i++;
      continue;
    }
    if (line.type === "context") {
      rows.push({
        kind: "row", left: line, right: line, leftIdx: i, rightIdx: i,
        key: `c-${i}`, anchor: i,
      });
      i++;
      continue;
    }
    const removed = [];
    const added = [];
    while (i < lines.length && lines[i].type === "removed") {
      removed.push({ line: lines[i], idx: i }); i++;
    }
    while (i < lines.length && lines[i].type === "added") {
      added.push({ line: lines[i], idx: i }); i++;
    }
    const max = Math.max(removed.length, added.length);
    for (let k = 0; k < max; k++) {
      const l = removed[k];
      const r = added[k];
      rows.push({
        kind: "row",
        left: l?.line || null,
        right: r?.line || null,
        leftIdx: l?.idx,
        rightIdx: r?.idx,
        anchor: l?.idx ?? r?.idx,
        key: `ch-${l?.idx ?? "_"}-${r?.idx ?? "_"}-${k}`,
      });
    }
  }
  return rows;
}

function SplitDiff({
  file, diff, focusedLine, setFocusedLine,
  onComment, onUpdateComment, onDeleteComment, getComments,
  commentingLine, setCommentingLine, commentText, setCommentText,
  editingId, setEditingId, editText, setEditText,
}) {
  const rows = useMemo(() => buildSplitRows(diff), [diff]);

  return html`
    <table class="diff-table split">
      <colgroup>
        <col class="gutter" />
        <col class="content" />
        <col class="divider" />
        <col class="gutter" />
        <col class="content" />
      </colgroup>
      <tbody>
        ${rows.map((row) => {
          const focused = row.anchor === focusedLine;
          if (row.kind === "header") {
            return html`
              <tr key=${row.key} class=${`diff-line header ${focused ? "is-focused" : ""}`}>
                <td colspan="5">${row.content}</td>
              </tr>
            `;
          }
          const leftKey = row.leftIdx != null ? `${file}:L${row.leftIdx}` : null;
          const rightKey = row.rightIdx != null ? `${file}:R${row.rightIdx}` : null;
          const isCommentingLeft = leftKey && commentingLine === leftKey;
          const isCommentingRight = rightKey && commentingLine === rightKey;

          const leftType = row.left ? row.left.type : "empty";
          const rightType = row.right ? row.right.type : "empty";

          const leftComments = row.leftIdx != null ? getComments(file, row.leftIdx) : [];
          const rightComments = row.rightIdx != null ? getComments(file, row.rightIdx) : [];

          return html`
            <tr
              key=${row.key}
              class=${`diff-row ${focused ? "is-focused" : ""}`}
              onClick=${() => setFocusedLine(row.anchor)}
            >
              <td
                class=${`diff-line-num diff-side ${leftType}`}
                onClick=${(e) => {
                  e.stopPropagation();
                  if (row.leftIdx == null) return;
                  setFocusedLine(row.leftIdx);
                  setCommentingLine(isCommentingLeft ? null : leftKey);
                }}
              >${row.left?.oldNum || ""}</td>
              <td class=${`diff-line-content diff-side ${leftType}`}>${row.left ? row.left.content : ""}</td>
              <td class="side-divider"></td>
              <td
                class=${`diff-line-num diff-side ${rightType}`}
                onClick=${(e) => {
                  e.stopPropagation();
                  if (row.rightIdx == null) return;
                  setFocusedLine(row.rightIdx);
                  setCommentingLine(isCommentingRight ? null : rightKey);
                }}
              >${row.right?.newNum || ""}</td>
              <td class=${`diff-line-content diff-side ${rightType}`}>${row.right ? row.right.content : ""}</td>
            </tr>
            ${(isCommentingLeft || isCommentingRight) &&
              html`<${CommentEditor}
                colspan=${5}
                file=${file}
                line=${isCommentingLeft ? row.leftIdx : row.rightIdx}
                commentText=${commentText}
                setCommentText=${setCommentText}
                onSubmit=${onComment}
                onCancel=${() => setCommentingLine(null)}
              />`}
            ${(leftComments.length > 0 || rightComments.length > 0) &&
              html`<${CommentList}
                colspan=${5}
                comments=${[...leftComments, ...rightComments]}
                editingId=${editingId}
                editText=${editText}
                setEditingId=${setEditingId}
                setEditText=${setEditText}
                onUpdate=${onUpdateComment}
                onDelete=${onDeleteComment}
              />`}
          `;
        })}
      </tbody>
    </table>
  `;
}

// ───────────────── shared sub-components ─────────────────

function CommentEditor({ colspan, file, line, commentText, setCommentText, onSubmit, onCancel }) {
  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (commentText.trim()) onSubmit(file, line, commentText);
    }
  }
  return html`
    <tr class="comment-row">
      <td colspan=${colspan}>
        <div class="comment-section">
          <textarea
            class="comment-input"
            placeholder="Leave a note for pi about this line…    (⌘↵ to submit)"
            value=${commentText}
            onInput=${(e) => setCommentText(e.target.value)}
            onKeyDown=${onKey}
            autofocus
          />
          <div class="comment-actions">
            <button class="cancel" onClick=${onCancel}>Cancel</button>
            <button
              class="submit"
              onClick=${() => onSubmit(file, line, commentText)}
              disabled=${!commentText.trim()}
            >Comment</button>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function CommentList({
  colspan, comments,
  editingId, editText, setEditingId, setEditText,
  onUpdate, onDelete,
}) {
  return html`
    <tr class="comment-row">
      <td colspan=${colspan}>
        <div class="existing-comments">
          ${comments.map((c) => {
            const editing = editingId === c.id;
            return html`
              <div class="comment" key=${c.id}>
                <div class="comment-header">
                  <span>${new Date(c.createdAt).toLocaleTimeString()}</span>
                  <span class="comment-actions-row">
                    <span class=${`comment-status ${c.status}`}>${c.status}</span>
                    ${c.status === "pending" && !editing && html`
                      <button
                        class="ghost-btn"
                        onClick=${() => { setEditingId(c.id); setEditText(c.content); }}
                        title="Edit"
                      >edit</button>
                    `}
                    ${!editing && html`
                      <button
                        class="ghost-btn danger"
                        onClick=${() => { if (confirm("Delete this comment?")) onDelete(c.id); }}
                        title="Delete"
                      >delete</button>
                    `}
                  </span>
                </div>
                ${editing
                  ? html`
                      <div class="comment-edit">
                        <textarea
                          class="comment-input"
                          value=${editText}
                          onInput=${(e) => setEditText(e.target.value)}
                          autofocus
                        />
                        <div class="comment-actions">
                          <button class="cancel" onClick=${() => setEditingId(null)}>Cancel</button>
                          <button
                            class="submit"
                            onClick=${() => onUpdate(c.id, editText)}
                            disabled=${!editText.trim()}
                          >Save</button>
                        </div>
                      </div>
                    `
                  : html`<div class="comment-body">${c.content}</div>`}
              </div>
            `;
          })}
        </div>
      </td>
    </tr>
  `;
}

render(html`<${App} />`, document.getElementById("app"));
