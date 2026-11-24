/**
 * Client half of Novel Studio: the workbench panel.
 *
 * Layout follows the shipped `main` panel convention: registering a
 * `sidebar.panellist` id makes the sidebar own the button, and registering the
 * same id as a `main` key gives the panel its page. Three columns inside:
 * the chapter rail, the prose editor, and the materials/notes side panel.
 *
 * All data comes from the Host half over the same-origin route
 * `/novel-studio/api/...`: the browser cannot read the project files directly.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-novel-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/novel-studio/api';

    // ---------------------------------------------------------------- text

    const TEXT = {
      zh: {
        title: '小说工坊',
        untitled: '未命名作品',
        newProject: '新建作品',
        dirPlaceholder: '默认放在 DSH 的小说目录里',
        pickDir: '选目录…',
        create: '建这部',
        cancel: '取消',
        pickUnavailable: '这个界面拿不到目录选择器，作品会建在默认目录里。',
        projects: '作品',
        chapters: '章节',
        newChapter: '新增章节',
        materials: '素材',
        notes: '连续性',
        sources: '原料',
        newSource: '上传资料',
        sourceEmpty: '还没有上传原料。整本小说或设定资料放进来，设定官就能按需检索。',
        sourceUploading: '上传中…',
        sourceSearch: '检索这段原文',
        sourceSearchPlaceholder: '人物名、地点、事件或设定词',
        sourceNoHit: '没有命中。换个同义词或别名再试。',
        sourceHits: '命中',
        sourceChapters: '章',
        deleteSource: '移除',
        confirmDeleteSource: '确认移除这份原料？',
        adapt: '改编',
        adaptBrief: '改编要求',
        adaptOriginal: '原书原文',
        adaptDraft: '改编稿',
        adaptEmpty: '这一章还没有改编稿。让改编者交一版，或者直接在这里落笔。',
        adaptProposal: '改编者交来一版',
        adaptApplyProposal: '载入这一版',
        adaptAccept: '采用这一版',
        adaptRestore: '退回原书',
        confirmRestore: '确认把这一章退回原书？正文会清空，台账里本章的改动也会清掉。',
        adaptNotOpen: '现在轮不到这一章。改编是一章一章往下的，先改完前面几章。',
        adaptRename: '改章名',
        adaptRenamePrompt: '新的章名',
        adaptAhead: '轮到这一章',
        adaptDone: '全书改完',
        adaptSaved: '这一版已落地',
        untitledAdapt: '未命名改编',
        adaptFrom: '据此改编',
        confirmAdaptFrom: '用《{title}》建一部改编工程？章节会照原书一一对应。',
        emptyProject: '还没有作品。先建一个，再往下写。',
        selectProject: '先选一部作品。',
        selectChapter: '从左边选一章，或者新建一章。',
        editorPlaceholder: '在这里写正文。留白处就是还没落笔的地方。',
        summaryPlaceholder: '这一章写完之后，实际发生了什么（一段话）。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        conflict: '正文已被别处改动，先重新载入再决定怎么合并。',
        reload: '重新载入',
        words: '字',
        target: '目标',
        status: '状态',
        title_placeholder: '章名',
        delete: '删除',
        confirmDelete: '确认删除？',
        materialEmpty: '这一章还没有装配素材。',
        newMaterial: '新增素材',
        noNotes: '没有未解决的连续性提醒。',
        blocker: '硬伤',
        warning: '注意',
        info: '提示',
        resolve: '标记已解决',
        draft: '草稿',
        confirmed: '已确认',
        addMaterial: '装配到本章',
        removeMaterial: '从本章移出',
        chapterTitle: '章',
        statsChapters: '章数',
        statsWords: '总字数',
        statsMaterials: '素材',
        statsNotes: '待处理',
        loadFailed: '载入失败',
        saveFailed: '保存失败',
        deleteProject: '删除作品',
        confirmDeleteProject: '确认删除《{title}》？',
        confirmDeleteProjectKept: '确认删除《{title}》？这本书在自己的文件夹里，工作台只会把它从列表里移除，文件夹和里面的一切都留着。',
        deletedProject: '已删除',
        unlistedProject: '已从列表移除，文件夹还在',
      },
      en: {
        title: 'Novel Studio',
        newProject: 'New project',
        untitled: 'Untitled',
        dirPlaceholder: 'Stored under the DSH novel folder by default',
        pickDir: 'Choose folder…',
        create: 'Create',
        cancel: 'Cancel',
        pickUnavailable: 'This shell exposes no folder picker, so the book goes to the default folder.',
        projects: 'Projects',
        chapters: 'Chapters',
        newChapter: 'New chapter',
        materials: 'Materials',
        notes: 'Continuity',
        sources: 'Sources',
        newSource: 'Upload source',
        sourceEmpty: 'No source uploaded yet. Drop a reference novel or a notes file here and the settings agent can search it.',
        sourceUploading: 'Uploading…',
        sourceSearch: 'Search this source',
        sourceSearchPlaceholder: 'a name, place, event or invented term',
        sourceNoHit: 'Nothing matched. Try a synonym or an alias.',
        sourceHits: 'hits',
        sourceChapters: 'chapters',
        deleteSource: 'Remove',
        confirmDeleteSource: 'Remove this source?',
        adapt: 'Adapt',
        adaptBrief: 'Adaptation brief',
        adaptOriginal: 'Original',
        adaptDraft: 'Draft',
        adaptEmpty: 'No draft adapted for this chapter yet. Ask the adapter for one, or write here directly.',
        adaptProposal: 'The adapter submitted a version',
        adaptApplyProposal: 'Load this version',
        adaptAccept: 'Accept this version',
        adaptRestore: 'Restore the original',
        confirmRestore: 'Restore this chapter to the original? The draft is cleared and this chapter\'s ledger entries go with it.',
        adaptNotOpen: 'Not this chapter yet. Adaptation moves one chapter at a time, so finish the earlier ones first.',
        adaptRename: 'Rename',
        adaptRenamePrompt: 'New chapter title',
        adaptAhead: 'Due now',
        adaptDone: 'Whole book adapted',
        adaptSaved: 'This version is live',
        untitledAdapt: 'Untitled adaptation',
        adaptFrom: 'Adapt from this',
        confirmAdaptFrom: 'Start an adaptation project from "{title}"? Its chapter list is copied from the book.',
        emptyProject: 'No projects yet. Create one and start writing.',
        selectProject: 'Pick a project first.',
        selectChapter: 'Pick a chapter on the left, or create one.',
        editorPlaceholder: 'Write the prose here.',
        summaryPlaceholder: 'What this chapter actually turned out to be, in a paragraph.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        conflict: 'This chapter changed elsewhere. Reload before merging.',
        reload: 'Reload',
        words: 'words',
        target: 'target',
        status: 'status',
        title_placeholder: 'Chapter title',
        delete: 'Delete',
        confirmDelete: 'Delete for sure?',
        materialEmpty: 'No material attached to this chapter yet.',
        newMaterial: 'New material',
        noNotes: 'No open continuity notes.',
        blocker: 'blocker',
        warning: 'warning',
        info: 'info',
        resolve: 'Resolve',
        draft: 'draft',
        confirmed: 'confirmed',
        addMaterial: 'Attach',
        removeMaterial: 'Detach',
        chapterTitle: 'Chapter',
        statsChapters: 'chapters',
        statsWords: 'words',
        statsMaterials: 'materials',
        statsNotes: 'open notes',
        loadFailed: 'Load failed',
        saveFailed: 'Save failed',
        deleteProject: 'Delete book',
        confirmDeleteProject: 'Delete "{title}"?',
        confirmDeleteProjectKept: 'Delete "{title}"? This book lives in its own folder — the workbench only takes it off the list; the folder and everything in it stay.',
        deletedProject: 'Deleted',
        unlistedProject: 'Taken off the list; the folder is still there',
      },
    };

    let t = TEXT.zh;
    /** Shell services the plugin asked for; `apply` fills this in. */
    const services = { ctx: null };

    // -------------------------------------------------------------- styles

    const CSS = `
.ns-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.6;
}
.ns-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  flex: none;
}
.ns-bar-title { font-weight: 600; letter-spacing: .02em; }
.ns-bar-title span { color: var(--dsw-alias-label-secondary); font-weight: 400; margin-left: 8px; }
.ns-bar-title .ns-bar-dir {
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  /* No direction: rtl trick here: it would push the drive letter to the right
     edge and make D:\小说\雨夜 read backwards. */
  font-variant-numeric: tabular-nums;
}
.ns-bar-spacer { flex: 1; }
.ns-stat {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ns-stat b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.ns-body { display: flex; flex: 1; min-height: 0; }

.ns-form {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  flex: none;
}
.ns-input {
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 5px;
  padding: 4px 8px;
  min-width: 0;
}
.ns-form-title { width: 200px; }
.ns-form-dir {
  flex: 0 1 380px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
}

.ns-rail {
  width: 248px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-specific-sidebar-fill);
  min-height: 0;
}
.ns-rail-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  letter-spacing: .04em;
}
.ns-rail-head .ns-grow { flex: 1; }
.ns-list { overflow: auto; flex: 1; min-height: 0; padding: 6px; }
.ns-item {
  display: flex; align-items: baseline; gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ns-item:hover { background: var(--dsw-alias-bg-layer-2); }
.ns-item[data-active='1'] {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
}
.ns-item .ns-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ns-item .ns-words { color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.ns-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary); }
.ns-dot[data-s='drafted'], .ns-dot[data-s='done'] { background: var(--dsw-alias-state-success-primary); }
.ns-dot[data-s='drafting'], .ns-dot[data-s='revising'] { background: var(--dsw-alias-state-warn-primary); }

.ns-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ns-toolbar {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: none;
}
.ns-grow { flex: 1; }
.ns-title-input {
  flex: 1; min-width: 0;
  background: transparent; border: none; outline: none;
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 15px; font-weight: 600;
  padding: 2px 0;
}
.ns-title-input::placeholder { color: var(--dsw-alias-label-secondary); font-weight: 400; }
.ns-editor {
  flex: 1; min-height: 0;
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 15px;
  line-height: 1.9;
  padding: 20px 24px;
  font-family: inherit;
}
.ns-editor::placeholder { color: var(--dsw-alias-label-secondary); }
.ns-summary {
  flex: none;
  border-top: 1px solid var(--dsw-alias-border-l1);
  padding: 10px 16px 14px;
}
.ns-summary textarea {
  width: 100%;
  box-sizing: border-box;
  min-height: 52px;
  resize: vertical;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  padding: 8px 10px;
  outline: none;
}
.ns-summary textarea:focus { border-color: var(--dsw-alias-border-l2); }

.ns-side {
  width: 292px; flex: none;
  display: flex; flex-direction: column;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  min-height: 0;
}
.ns-tabs { display: flex; gap: 2px; padding: 6px 8px 0; flex: none; }
.ns-tab {
  border: none; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px;
  padding: 5px 10px;
  border-radius: 6px 6px 0 0;
  border-bottom: 2px solid transparent;
}
.ns-tab[data-active='1'] {
  color: var(--dsw-alias-label-primary);
  border-bottom-color: var(--dsw-alias-brand-primary);
}
.ns-pane { overflow: auto; flex: 1; min-height: 0; padding: 8px; }

.ns-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  padding: 10px;
  margin-bottom: 8px;
}
.ns-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.ns-card-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ns-tag {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  padding: 0 7px;
  white-space: nowrap;
}
.ns-tag[data-s='blocker'] { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.ns-tag[data-s='warning'] { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.ns-tag[data-s='confirmed'] { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.ns-body-text {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 8.5em;
  overflow: hidden;
}

.ns-btn {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
}
.ns-btn:hover { border-color: var(--dsw-alias-border-l2); }
.ns-btn[disabled] { opacity: .5; cursor: default; }
.ns-btn-primary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
}
.ns-btn-quiet { background: transparent; }
.ns-error {
  color: var(--dsw-alias-state-error-primary);
  padding: 14px 16px;
  font-size: 12px;
}
.ns-note {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  margin-bottom: 8px;
  font-size: 12px;
}
.ns-note[data-s='blocker'] { border-color: var(--dsw-alias-state-error-primary); }
.ns-note[data-s='warning'] { border-color: var(--dsw-alias-state-warn-primary); }
.ns-note-subject { font-weight: 600; margin-bottom: 2px; }
.ns-empty {
  color: var(--dsw-alias-label-secondary);
  padding: 24px 16px;
  text-align: center;
  font-size: 12px;
}
.ns-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  outline: none;
}
.ns-input:focus { border-color: var(--dsw-alias-border-l2); }
.ns-input::placeholder { color: var(--dsw-alias-label-secondary); }
.ns-hit {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
}
.ns-hit-head {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 2px;
}
label.ns-btn { display: inline-block; }
.ns-center { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 10px; }

/* Adaptation: the original beside the draft, because "is this still the same
   scene?" has to be answerable without leaving the chapter. */
.ns-adaptbar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  flex: none;
}
.ns-adaptflag {
  font-size: 11px;
  color: var(--dsw-alias-brand-primary);
  border: 1px solid currentColor;
  border-radius: 999px;
  padding: 0 7px;
  white-space: nowrap;
}
.ns-dual { display: flex; flex: 1; min-height: 0; }
.ns-orig, .ns-draft { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.ns-orig { border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.ns-pane-head {
  flex: none;
  padding: 6px 16px;
  font-size: 11px;
  letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.ns-orig-text {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 20px;
  font-size: 14px;
  line-height: 1.9;
  white-space: pre-wrap;
  color: var(--dsw-alias-label-secondary);
}
`;

    // ------------------------------------------------------------- helpers

    async function call(method, path, body) {
      const init = { method, headers: {} };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(API + path, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const error = new Error((payload && payload.error) || `HTTP ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    /**
     * The Client-side workspace services, if this shell exposes them.
     *
     * `uiWorkspace.pickDirectory()` is the Host's own folder chooser: it is the
     * only way to obtain a real directory path, since a browser file input
     * never reveals one and the Client cannot touch the filesystem. Optional on
     * purpose — a shell without it still works, the author just cannot pick.
     */
    function hostService() {
      try {
        return services.ctx && typeof services.ctx.get === 'function' ? services.ctx.get('uiWorkspace') : undefined;
      } catch {
        return undefined;
      }
    }

    function words(value) {
      const text = typeof value === 'string' ? value : '';
      const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
      const latin = (
        text
          .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
          .match(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g) || []
      ).length;
      return cjk + latin;
    }

    // ------------------------------------------------------- icon component

    function Icon(props) {
      const size = props.size || 18;
      return h(
        'svg',
        {
          viewBox: '0 0 20 20',
          width: size,
          height: size,
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M4 3h8.5L16 6.5V17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12.5 3v3.5H16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M7 10h6M7 13h4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        })
      );
    }

    // -------------------------------------------------------------- panel

    function Workbench() {
      const [listState, setListState] = React.useState({ loading: true, error: null, projects: [] });
      const [projectId, setProjectId] = React.useState(null);
      const [project, setProject] = React.useState(null);
      const [chapters, setChapters] = React.useState([]);
      const [chapterId, setChapterId] = React.useState(null);
      const [chapter, setChapter] = React.useState(null);
      const [title, setTitle] = React.useState('');
      const [prose, setProse] = React.useState('');
      const [summary, setSummary] = React.useState('');
      const [dirty, setDirty] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [tab, setTab] = React.useState('materials');
      // Raw-material library: shared by every project, so it has no project key.
      const [sourceState, setSourceState] = React.useState({ loading: true, error: null, items: [] });
      const [sourceQuery, setSourceQuery] = React.useState('');
      const [sourceHits, setSourceHits] = React.useState(null);
      const [uploading, setUploading] = React.useState(false);
      // A chapter to open once its project finishes loading (session restore).
      const [pendingChapter, setPendingChapter] = React.useState(null);
      // New-project form. A book can be started on its own, or in a directory
      // picked from the host's own file dialog.
      const [form, setForm] = React.useState(null);

      // ---- project list
      const loadList = React.useCallback(async () => {
        try {
          const payload = await call('GET', '/projects');
          setListState({ loading: false, error: null, projects: payload.projects || [] });
          return payload.projects || [];
        } catch (error) {
          setListState({ loading: false, error: error.message, projects: [] });
          return [];
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          const projects = await loadList();
          if (!alive) return;
          if (!projects.length) return;
          // Reopen what the author had last time. The host keeps this pointer so
          // a role agent can answer "this chapter" without being told which one;
          // restoring it here also means the panel comes back where it was left.
          let resume = null;
          try {
            const payload = await call('GET', '/active');
            resume = payload.active || null;
          } catch {
            resume = null;
          }
          if (!alive) return;
          const known = resume && projects.some((item) => item.id === resume.projectId);
          if (known) {
            // Queue the chapter rather than setting it now: switching the
            // project clears the open chapter, so a chapter set here would be
            // wiped by that effect a render later. `pendingChapter` is applied
            // once the project has actually loaded.
            setPendingChapter(resume.chapterId || null);
            setProjectId(resume.projectId);
          } else if (!projectId) {
            setProjectId(projects[0].id);
          }
        })();
        return () => {
          alive = false;
        };
      }, [loadList]);

      // Tell the host which project and chapter are open. Failures are ignored
      // on purpose: this is a convenience pointer, and a stale one only costs a
      // vaguer opening line, never a wrong write.
      React.useEffect(() => {
        call('PUT', '/active', { projectId: projectId || '', chapterId: chapterId || '' }).catch(() => {});
      }, [projectId, chapterId]);

      // ---- one project
      const loadProject = React.useCallback(async (id) => {
        if (!id) return;
        try {
          const payload = await call('GET', `/projects/${id}`);
          setProject(payload.project);
          setChapters(payload.chapters || []);
          setNotice(null);
        } catch (error) {
          setNotice({ kind: 'error', text: `${t.loadFailed}: ${error.message}` });
        }
      }, []);

      React.useEffect(() => {
        if (projectId) loadProject(projectId);
        else {
          setProject(null);
          setChapters([]);
        }
        setChapterId(null);
        setChapter(null);
      }, [projectId, loadProject]);

      // Apply a restored chapter after the project switch cleared it.
      React.useEffect(() => {
        if (!pendingChapter || !project) return;
        const exists = chapters.some((row) => row.id === pendingChapter);
        if (exists) setChapterId(pendingChapter);
        setPendingChapter(null);
      }, [pendingChapter, project, chapters]);

      // ---- one chapter
      const loadChapter = React.useCallback(async (pid, cid) => {
        if (!pid || !cid) return;
        try {
          const payload = await call('GET', `/projects/${pid}/chapters/${encodeURIComponent(cid)}`);
          const row = payload.chapter || { id: cid, title: '', content: '', summary: '', revision: 0, materialIds: [] };
          setChapter(row);
          setTitle(row.title || '');
          setProse(row.content || '');
          setSummary(row.summary || '');
          setDirty(false);
          setNotice(null);
        } catch (error) {
          setNotice({ kind: 'error', text: `${t.loadFailed}: ${error.message}` });
        }
      }, []);

      React.useEffect(() => {
        if (projectId && chapterId) loadChapter(projectId, chapterId);
        else {
          setChapter(null);
          setProse('');
          setTitle('');
          setSummary('');
        }
      }, [projectId, chapterId, loadChapter]);

      // ---- save
      const save = React.useCallback(async () => {
        if (!projectId || !chapterId || saving) return;
        setSaving(true);
        try {
          const payload = await call('PUT', `/projects/${projectId}/chapters/${encodeURIComponent(chapterId)}`, {
            title,
            content: prose,
            summary,
            expectedRevision: chapter ? chapter.revision : 0,
          });
          setChapter(payload.chapter);
          setChapters(payload.chapters || []);
          setDirty(false);
          setNotice({ kind: 'ok', text: t.saved });
        } catch (error) {
          if (error.status === 409) setNotice({ kind: 'error', text: t.conflict });
          else setNotice({ kind: 'error', text: `${t.saveFailed}: ${error.message}` });
        } finally {
          setSaving(false);
        }
      }, [projectId, chapterId, chapter, title, prose, summary, saving]);

      // Ctrl/Cmd+S inside the editor.
      React.useEffect(() => {
        function onKey(event) {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            save();
          }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [save]);

      // ---- mutations
      async function createProject(input) {
        try {
          const body = { title: (input && input.title) || t.untitled };
          if (input && input.dir) body.dir = input.dir;
          const payload = await call('POST', '/projects', body);
          await loadList();
          setProjectId(payload.project.id);
          setForm(null);
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      // The host owns the folder chooser: a browser cannot read a real path out
      // of `<input type="file">`, and only the Host half can create directories.
      async function chooseDir() {
        try {
          const service = hostService();
          if (!service || typeof service.pickDirectory !== 'function') {
            setNotice({ kind: 'error', text: t.pickUnavailable });
            return;
          }
          const picked = await service.pickDirectory();
          if (typeof picked === 'string' && picked.trim()) {
            setForm((current) => ({ ...(current || { title: '' }), dir: picked.trim() }));
          }
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      // Starting an adaptation project from an uploaded book: the outline is
      // minted from the book's own chapters, so the two never drift apart.
      async function adaptFromSource(sourceId) {
        try {
          const payload = await call('POST', '/projects', {
            title: t.untitledAdapt,
            adaptation: { sourceId, brief: '' },
          });
          await loadList();
          setProjectId(payload.project.id);
          setTab('materials');
          setNotice({ kind: 'ok', text: `${payload.project.title} · ${payload.chapters.length} ${t.sourceChapters}` });
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      async function createChapter() {
        if (!projectId) return;
        try {
          const title2 = `${t.chapterTitle} ${chapters.length + 1}`;
          const payload = await call('POST', `/projects/${projectId}/outline`, { title: title2 });
          setChapters(payload.chapters || []);
          const created = (payload.chapters || []).find((row) => row.title === title2);
          if (created) setChapterId(created.id);
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      async function removeChapter(id) {
        if (!projectId || !window.confirm(t.confirmDelete)) return;
        try {
          const payload = await call('DELETE', `/projects/${projectId}/outline/${encodeURIComponent(id)}`);
          setChapters(payload.chapters || []);
          if (id === chapterId) setChapterId(null);
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      // Deleting a book. The wording has to depend on where the book lives: a
      // project in a folder the author picked is only taken off our list, and
      // saying "deleted" would send them looking for a folder that never left.
      async function removeProject() {
        if (!projectId) return;
        const row = listState.projects.find((item) => item.id === projectId) || {};
        const prompt = row.dir ? t.confirmDeleteProjectKept : t.confirmDeleteProject;
        if (!window.confirm(prompt.replace('{title}', row.title || t.untitled))) return;
        try {
          const payload = await call('DELETE', `/projects/${projectId}`);
          await loadList();
          setProjectId(null);
          setNotice({ kind: 'ok', text: payload.keptFiles ? t.unlistedProject : t.deletedProject });
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      async function addMaterial() {
        if (!projectId) return;
        try {
          const payload = await call('POST', `/projects/${projectId}/materials`, {
            kind: 'note',
            title: '新素材',
            content: '',
          });
          setProject(payload.project);
          setTab('materials');
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      async function attachMaterial(materialId) {
        if (!projectId) return;
        const current = Array.isArray(chapter?.materialIds) ? chapter.materialIds : [];
        if (current.includes(materialId)) return;
        try {
          const payload = await call('PUT', `/projects/${projectId}/chapters/${encodeURIComponent(chapterId)}`, {
            content: prose,
            title,
            summary,
            materialIds: current.concat(materialId),
            expectedRevision: chapter ? chapter.revision : 0,
          });
          setChapter(payload.chapter);
          setChapters(payload.chapters || []);
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      async function resolveNote(noteId) {
        if (!projectId) return;
        try {
          const payload = await call('POST', `/projects/${projectId}/notes`, { id: noteId, status: 'resolved' });
          setProject(payload.project);
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      // ---- raw-material library
      const loadSources = React.useCallback(async () => {
        try {
          const payload = await call('GET', '/sources');
          setSourceState({ loading: false, error: null, items: payload.sources || [] });
        } catch (error) {
          setSourceState({ loading: false, error: error.message, items: [] });
        }
      }, []);

      React.useEffect(() => {
        loadSources();
      }, [loadSources]);

      async function uploadSource(file) {
        if (!file || uploading) return;
        setUploading(true);
        setNotice(null);
        try {
          const query = `?filename=${encodeURIComponent(file.name)}&kind=novel`;
          // Bytes, not JSON: a seven-million-character book would cost more than
          // its own size again as an escaped JSON string, and the browser
          // already has the bytes.
          const response = await fetch(`${API}/sources/upload${query}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: file,
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`);
          await loadSources();
          setNotice({ kind: 'ok', text: `《${payload.source.title}》${payload.source.chapterCount} ${t.sourceChapters}` });
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        } finally {
          setUploading(false);
        }
      }

      async function removeSource(id) {
        if (!window.confirm(t.confirmDeleteSource)) return;
        try {
          await call('DELETE', `/sources/${encodeURIComponent(id)}`);
          setSourceHits(null);
          await loadSources();
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      async function searchSource(id) {
        const query = sourceQuery.trim();
        if (!query) return;
        try {
          const payload = await call('GET', `/sources/${encodeURIComponent(id)}/search?q=${encodeURIComponent(query)}&limit=6`);
          setSourceHits({ sourceId: id, hits: payload.hits || [], query });
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      // ---- adaptation
      //
      // The adapter never writes prose: it hands over a proposal. The panes below
      // put the original beside the draft so the author can see what changed
      // before accepting, which is the whole reason the proposal exists.
      const [adaptState, setAdaptState] = React.useState({ loading: false, error: null, data: null });
      const isAdapt = Boolean(project && project.adaptation);

      const loadAdapt = React.useCallback(async (pid, cid) => {
        if (!pid || !cid) return;
        setAdaptState((prev) => ({ ...prev, loading: true }));
        try {
          const payload = await call('GET', `/projects/${pid}/chapters/${encodeURIComponent(cid)}/adapt`);
          setAdaptState({ loading: false, error: null, data: payload });
        } catch (error) {
          // A plain writing project answers 404 here; that is not an error worth
          // showing, because the pane is simply not on screen for those.
          setAdaptState({ loading: false, error: error.status === 404 ? null : error.message, data: null });
        }
      }, []);

      React.useEffect(() => {
        if (isAdapt && projectId && chapterId) loadAdapt(projectId, chapterId);
        else setAdaptState({ loading: false, error: null, data: null });
      }, [isAdapt, projectId, chapterId, loadAdapt]);

      async function applyProposal() {
        const proposal = adaptState.data && adaptState.data.proposal;
        if (!proposal) return;
        setProse(proposal.content || '');
        if (typeof proposal.summary === 'string') setSummary(proposal.summary);
        setDirty(true);
      }

      async function acceptVersion() {
        if (!projectId || !chapterId || saving) return;
        const proposal = adaptState.data && adaptState.data.proposal;
        setSaving(true);
        try {
          // The editor is the source of truth: the author may have edited the
          // proposal before pressing accept, and that edit is the version they
          // mean. The proposal only supplies its ledger entries.
          const payload = await call(
            'POST',
            `/projects/${projectId}/chapters/${encodeURIComponent(chapterId)}/adapt/accept`,
            {
              ...(proposal ? { proposalId: proposal.id } : {}),
              content: prose,
              summary,
              ...(proposal && Array.isArray(proposal.changes) ? { changes: proposal.changes } : {}),
            }
          );
          setChapter(payload.chapter);
          setChapters(payload.chapters || []);
          setProject((prev) => (prev ? { ...prev, adaptation: payload.adaptation } : prev));
          setDirty(false);
          setNotice({ kind: 'ok', text: t.adaptSaved });
          await loadAdapt(projectId, chapterId);
        } catch (error) {
          if (error.status === 409) setNotice({ kind: 'error', text: error.message });
          else setNotice({ kind: 'error', text: `${t.saveFailed}: ${error.message}` });
        } finally {
          setSaving(false);
        }
      }

      async function restoreOriginal() {
        if (!projectId || !chapterId || saving) return;
        if (!window.confirm(t.confirmRestore)) return;
        setSaving(true);
        try {
          const payload = await call(
            'POST',
            `/projects/${projectId}/chapters/${encodeURIComponent(chapterId)}/adapt/accept`,
            { restore: true }
          );
          setProse('');
          setSummary('');
          setChapter(payload.chapter);
          setChapters(payload.chapters || []);
          setProject((prev) => (prev ? { ...prev, adaptation: payload.adaptation } : prev));
          setDirty(false);
          await loadAdapt(projectId, chapterId);
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        } finally {
          setSaving(false);
        }
      }

      async function renameAdaptChapter() {
        if (!projectId || !chapterId) return;
        const next = window.prompt(t.adaptRenamePrompt, title);
        if (next === null) return;
        const trimmed = next.trim();
        if (!trimmed || trimmed === title) return;
        try {
          const payload = await call(
            'POST',
            `/projects/${projectId}/chapters/${encodeURIComponent(chapterId)}/adapt/rename`,
            { title: trimmed }
          );
          setTitle(trimmed);
          setChapters(payload.chapters || []);
          setProject((prev) => (prev ? { ...prev, adaptation: payload.adaptation } : prev));
          setDirty(false);
          setNotice({ kind: 'ok', text: t.saved });
          await loadAdapt(projectId, chapterId);
        } catch (error) {
          setNotice({ kind: 'error', text: error.message });
        }
      }

      // ---- render
      const stats = project
        ? (() => {
            let words2 = 0;
            for (const row of chapters) words2 += row.words || 0;
            const openNotes = (project.notes || []).filter((note) => note.status === 'open').length;
            return { chapters: chapters.length, words: words2, materials: (project.materials || []).length, openNotes };
          })()
        : null;

      const materialIds = Array.isArray(chapter?.materialIds) ? chapter.materialIds : [];
      const materials = project ? project.materials || [] : [];
      const attached = materials.filter((item) => materialIds.includes(item.id));
      const openNotes = project ? (project.notes || []).filter((note) => note.status === 'open') : [];
      // The index row carries the chosen folder, if the author picked one.
      const currentDir = (listState.projects.find((item) => item.id === projectId) || {}).dir || '';

      const bar = h(
        'div',
        { className: 'ns-bar' },
        h(
          'div',
          { className: 'ns-bar-title' },
          t.title,
          project ? h('span', null, project.title) : null,
          // Where the files actually are. A book kept in a folder the author
          // picked is only trustworthy if they can see that folder's name.
          currentDir ? h('span', { className: 'ns-bar-dir', title: currentDir }, currentDir) : null
        ),
        h('div', { className: 'ns-bar-spacer' }),
        stats &&
          h(
            'div',
            { className: 'ns-stat' },
            `${t.statsChapters} `,
            h('b', null, String(stats.chapters)),
            ` · ${t.statsWords} `,
            h('b', null, String(stats.words)),
            ` · ${t.statsMaterials} `,
            h('b', null, String(stats.materials)),
            ` · ${t.statsNotes} `,
            h('b', null, String(stats.openNotes))
          ),
        project &&
          h('button', { className: 'ns-btn ns-btn-quiet', type: 'button', onClick: removeProject }, t.deleteProject),
        h(
          'button',
          {
            className: 'ns-btn',
            type: 'button',
            onClick: () => setForm((current) => current || { title: '', dir: '' }),
          },
          t.newProject
        )
      );

      // New-project sheet: a title, and optionally a folder from the host's own
      // chooser. Everything the book generates afterwards lands in that folder.
      const startProject = () => createProject({ title: form.title.trim(), dir: form.dir });
      // Enter submits, Escape backs out: the form behaves like the host's own
      // dialogs even though it is only a row above the desk.
      const formKeys = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          startProject();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setForm(null);
        }
      };
      const formRow = form
        ? h(
            'div',
            { className: 'ns-form', onKeyDown: formKeys },
            h('input', {
              className: 'ns-input ns-form-title',
              placeholder: t.untitled,
              value: form.title,
              autoFocus: true,
              onChange: (event) => setForm({ ...form, title: event.target.value }),
            }),
            h('input', {
              className: 'ns-input ns-form-dir',
              placeholder: t.dirPlaceholder,
              value: form.dir,
              readOnly: true,
              title: form.dir,
            }),
            h('button', { className: 'ns-btn', type: 'button', onClick: chooseDir }, t.pickDir),
            h('div', { className: 'ns-bar-spacer' }),
            h(
              'button',
              {
                className: 'ns-btn ns-btn-primary',
                type: 'button',
                onClick: startProject,
              },
              t.create
            ),
            h('button', { className: 'ns-btn ns-btn-quiet', type: 'button', onClick: () => setForm(null) }, t.cancel)
          )
        : null;

      const rail = h(
        'div',
        { className: 'ns-rail' },
        h(
          'div',
          { className: 'ns-rail-head' },
          h('span', null, t.projects),
          h('span', { className: 'ns-grow' })
        ),
        h(
          'div',
          { className: 'ns-list', style: { flex: 'none', maxHeight: '38%' } },
          listState.projects.map((item) =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'ns-item',
                'data-active': item.id === projectId ? '1' : '0',
                onClick: () => setProjectId(item.id),
              },
              h('span', { className: 'ns-name' }, item.title),
              h('span', { className: 'ns-words' }, String(item.words ?? 0))
            )
          ),
          !listState.projects.length && h('div', { className: 'ns-empty' }, t.emptyProject)
        ),
        h(
          'div',
          { className: 'ns-rail-head' },
          h('span', null, t.chapters),
          h('span', { className: 'ns-grow' }),
          project &&
            h('button', { className: 'ns-btn ns-btn-quiet', type: 'button', onClick: createChapter }, t.newChapter)
        ),
        h(
          'div',
          { className: 'ns-list' },
          chapters.map((row) =>
            h(
              'button',
              {
                key: row.id,
                type: 'button',
                className: 'ns-item',
                'data-active': row.id === chapterId ? '1' : '0',
                onClick: () => setChapterId(row.id),
              },
              h('span', { className: 'ns-dot', 'data-s': row.status }),
              h('span', { className: 'ns-name' }, row.title),
              h('span', { className: 'ns-words' }, row.words ? String(row.words) : '')
            )
          ),
          !chapters.length && project && h('div', { className: 'ns-empty' }, t.selectChapter)
        )
      );

      let main;
      if (!projectId) {
        main = h(
          'div',
          { className: 'ns-main' },
          h('div', { className: 'ns-center' }, h('div', { className: 'ns-empty' }, t.selectProject))
        );
      } else if (!chapterId) {
        main = h(
          'div',
          { className: 'ns-main' },
          h(
            'div',
            { className: 'ns-center' },
            h('div', { className: 'ns-empty' }, t.selectChapter),
            h('button', { className: 'ns-btn ns-btn-primary', type: 'button', onClick: createChapter }, t.newChapter)
          )
        );
      } else {
        main = h(
          'div',
          { className: 'ns-main' },
          h(
            'div',
            { className: 'ns-toolbar' },
            h('input', {
              className: 'ns-title-input',
              value: title,
              placeholder: t.title_placeholder,
              onChange: (event) => {
                setTitle(event.target.value);
                setDirty(true);
              },
            }),
            h('span', { className: 'ns-stat' }, `${words(prose)} ${t.words}`),
            notice &&
              h(
                'span',
                {
                  className: 'ns-stat',
                  style: {
                    color:
                      notice.kind === 'error'
                        ? 'var(--dsw-alias-state-error-primary)'
                        : 'var(--dsw-alias-state-success-primary)',
                  },
                },
                notice.text
              ),
            notice && notice.kind === 'error' && chapter
              ? h(
                  'button',
                  {
                    className: 'ns-btn',
                    type: 'button',
                    onClick: () => loadChapter(projectId, chapterId),
                  },
                  t.reload
                )
              : null,
            h(
              'button',
              {
                className: 'ns-btn ns-btn-primary',
                type: 'button',
                disabled: saving || !dirty,
                onClick: save,
              },
              saving ? t.saving : t.save
            ),
            h(
              'button',
              {
                className: 'ns-btn ns-btn-quiet',
                type: 'button',
                onClick: () => removeChapter(chapterId),
              },
              t.delete
            )
          ),
          // An adaptation project edits one chapter of an existing book, so the
          // original stays on screen beside the draft. Without it "is this still
          // the same scene?" can only be answered from memory.
          isAdapt
            ? h(
                'div',
                { className: 'ns-adaptbar' },
                h('span', { className: 'ns-adaptflag' }, t.adapt),
                adaptState.data && adaptState.data.open === false
                  ? h('span', { className: 'ns-stat' }, t.adaptNotOpen)
                  : adaptState.data && adaptState.data.cursor
                    ? h('span', { className: 'ns-stat' }, t.adaptAhead)
                    : h('span', { className: 'ns-stat' }, t.adaptDone),
                adaptState.data && adaptState.data.proposal
                  ? h(
                      'button',
                      { className: 'ns-btn', type: 'button', onClick: applyProposal },
                      `${t.adaptProposal} · ${t.adaptApplyProposal}`
                    )
                  : null,
                h('span', { className: 'ns-grow' }),
                h(
                  'button',
                  { className: 'ns-btn ns-btn-quiet', type: 'button', onClick: renameAdaptChapter },
                  t.adaptRename
                ),
                h(
                  'button',
                  { className: 'ns-btn ns-btn-quiet', type: 'button', onClick: restoreOriginal, disabled: saving },
                  t.adaptRestore
                ),
                h(
                  'button',
                  { className: 'ns-btn ns-btn-primary', type: 'button', onClick: acceptVersion, disabled: saving || !prose.trim() },
                  t.adaptAccept
                )
              )
            : null,
          isAdapt
            ? h(
                'div',
                { className: 'ns-dual' },
                h(
                  'div',
                  { className: 'ns-orig' },
                  h('div', { className: 'ns-pane-head' }, t.adaptOriginal),
                  h(
                    'div',
                    { className: 'ns-orig-text' },
                    adaptState.data && adaptState.data.original
                      ? adaptState.data.original.content
                      : adaptState.loading
                        ? '…'
                        : (adaptState.error || t.adaptEmpty)
                  )
                ),
                h(
                  'div',
                  { className: 'ns-draft' },
                  h('div', { className: 'ns-pane-head' }, t.adaptDraft),
                  h('textarea', {
                    className: 'ns-editor',
                    value: prose,
                    placeholder: t.editorPlaceholder,
                    spellCheck: false,
                    onChange: (event) => {
                      setProse(event.target.value);
                      setDirty(true);
                    },
                  })
                )
              )
            : h('textarea', {
                className: 'ns-editor',
                value: prose,
                placeholder: t.editorPlaceholder,
                spellCheck: false,
                onChange: (event) => {
                  setProse(event.target.value);
                  setDirty(true);
                },
              }),
          h(
            'div',
            { className: 'ns-summary' },
            h('textarea', {
              value: summary,
              placeholder: t.summaryPlaceholder,
              onChange: (event) => {
                setSummary(event.target.value);
                setDirty(true);
              },
            })
          )
        );
      }

      const notesPane = openNotes.length
        ? openNotes.map((note) =>
            h(
              'div',
              { key: note.id, className: 'ns-note', 'data-s': note.severity },
              h('div', { className: 'ns-note-subject' }, note.subject || note.category),
              h('div', null, note.description),
              h(
                'div',
                { style: { marginTop: '6px', display: 'flex', justifyContent: 'flex-end' } },
                h(
                  'button',
                  { className: 'ns-btn ns-btn-quiet', type: 'button', onClick: () => resolveNote(note.id) },
                  t.resolve
                )
              )
            )
          )
        : [h('div', { key: 'empty', className: 'ns-empty' }, t.noNotes)];

      // The library is shared by every project, so this pane never depends on
      // which project happens to be open.
      // A label bound to the hidden picker opens it without any JS, which keeps
      // the pane free of refs and of document lookups.
      const uploader = h('input', {
        key: 'picker',
        id: 'ns-source-file',
        type: 'file',
        accept: '.txt,.md,.markdown,.html,.htm',
        style: { display: 'none' },
        onChange: (event) => {
          const file = event.target.files && event.target.files[0];
          event.target.value = '';
          uploadSource(file);
        },
      });

      const sourcesPane = [
        h(
          'div',
          { key: 'head', style: { display: 'flex', gap: '8px', marginBottom: '8px' } },
          h('span', { className: 'ns-grow' }),
          uploading
            ? h('span', { className: 'ns-tag' }, t.sourceUploading)
            : h('label', { htmlFor: 'ns-source-file', className: 'ns-btn' }, t.newSource)
        ),
        ...sourceState.items.map((item) =>
          h(
            'div',
            { key: item.id, className: 'ns-card' },
            h(
              'div',
              { className: 'ns-card-head' },
              h('span', { className: 'ns-card-title' }, item.title || item.filename),
              h('span', { className: 'ns-tag' }, `${item.chapterCount} ${t.sourceChapters}`),
              h(
                'button',
                {
                  className: 'ns-btn ns-btn-quiet',
                  type: 'button',
                  onClick: () => {
                    if (!window.confirm(t.confirmAdaptFrom.replace('{title}', item.title || item.filename))) return;
                    adaptFromSource(item.id);
                  },
                },
                t.adaptFrom
              ),
              h(
                'button',
                {
                  className: 'ns-btn ns-btn-quiet',
                  type: 'button',
                  onClick: () => removeSource(item.id),
                },
                t.deleteSource
              )
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
              h('input', {
                className: 'ns-input',
                type: 'text',
                placeholder: t.sourceSearchPlaceholder,
                value: sourceQuery,
                onChange: (event) => setSourceQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') searchSource(item.id);
                },
              }),
              h(
                'button',
                { className: 'ns-btn ns-btn-quiet', type: 'button', onClick: () => searchSource(item.id) },
                t.sourceSearch
              )
            ),
            sourceHits && sourceHits.sourceId === item.id
              ? sourceHits.hits.length
                ? sourceHits.hits.map((hit) =>
                    h(
                      'div',
                      { key: hit.chapterId, className: 'ns-hit' },
                      h('div', { className: 'ns-hit-head' }, `${hit.chapterId} · ${hit.title}`),
                      h('div', { className: 'ns-body-text' }, hit.snippet)
                    )
                  )
                : h('div', { className: 'ns-empty', style: { padding: '10px 0' } }, t.sourceNoHit)
              : null
          )
        ),
        sourceState.items.length ? null : h('div', { key: 'empty', className: 'ns-empty' }, t.sourceEmpty),
      ];

      const side = h(
        'div',
        { className: 'ns-side' },
        uploader,
        h(
          'div',
          { className: 'ns-tabs' },
          h(
            'button',
            { type: 'button', className: 'ns-tab', 'data-active': tab === 'materials' ? '1' : '0', onClick: () => setTab('materials') },
            `${t.materials} (${attached.length})`
          ),
          h(
            'button',
            { type: 'button', className: 'ns-tab', 'data-active': tab === 'notes' ? '1' : '0', onClick: () => setTab('notes') },
            `${t.notes} (${openNotes.length})`
          ),
          h(
            'button',
            { type: 'button', className: 'ns-tab', 'data-active': tab === 'sources' ? '1' : '0', onClick: () => setTab('sources') },
            `${t.sources} (${sourceState.items.length})`
          )
        ),
        h(
          'div',
          { className: 'ns-pane' },
          tab === 'materials'
            ? [
                h(
                  'div',
                  { key: 'head', style: { display: 'flex', marginBottom: '8px' } },
                  h('span', { className: 'ns-grow' }),
                  h('button', { className: 'ns-btn', type: 'button', onClick: addMaterial }, t.newMaterial)
                ),
                ...attached.map((item) =>
                  h(
                    'div',
                    { key: item.id, className: 'ns-card' },
                    h(
                      'div',
                      { className: 'ns-card-head' },
                      h('span', { className: 'ns-card-title' }, item.title),
                      h('span', { className: 'ns-tag', 'data-s': item.status }, item.status === 'confirmed' ? t.confirmed : t.draft)
                    ),
                    item.usage ? h('div', { className: 'ns-body-text' }, item.usage) : null,
                    item.content ? h('div', { className: 'ns-body-text' }, item.content) : null
                  )
                ),
                attached.length ? null : h('div', { className: 'ns-empty' }, t.materialEmpty),
                materials.length > attached.length
                  ? h(
                      'div',
                      { key: 'others', style: { marginTop: '12px' } },
                      ...materials
                        .filter((item) => !materialIds.includes(item.id))
                        .map((item) =>
                          h(
                            'div',
                            { key: item.id, className: 'ns-card' },
                            h(
                              'div',
                              { className: 'ns-card-head' },
                              h('span', { className: 'ns-card-title' }, item.title),
                              h(
                                'button',
                                {
                                  className: 'ns-btn ns-btn-quiet',
                                  type: 'button',
                                  disabled: !chapterId,
                                  onClick: () => attachMaterial(item.id),
                                },
                                t.addMaterial
                              )
                            )
                          )
                        )
                    )
                  : null,
              ]
            : tab === 'sources'
              ? sourcesPane
              : notesPane
        )
      );

      return h(
        'div',
        { className: 'ns-root' },
        bar,
        listState.error ? h('div', { className: 'ns-error' }, listState.error) : null,
        form ? formRow : null,
        h('div', { className: 'ns-body' }, rail, main, side)
      );
    }

    // ------------------------------------------------------------- plugin

    const STYLE_ID = '@local/dsh-novel-studio/workbench.css';

    /** Insert the workbench stylesheet once, and hand back its removal. */
    function insertStyles() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/dsh-novel-studio';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag);
      };
    }

    /** Follow the shell language without hard-depending on the locale service. */
    function followLocale(ctx) {
      function read() {
        try {
          const service = typeof ctx.get === 'function' ? ctx.get('locale') : null;
          if (!service) return null;
          return typeof service.getLocale === 'function' ? service.getLocale() : null;
        } catch {
          return null;
        }
      }
      function apply(id) {
        t = id && String(id).toLowerCase().startsWith('en') ? TEXT.en : TEXT.zh;
      }
      apply(read());
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('locale') : null;
        if (!service) return () => {};
        const stop = service.subscribe(() => apply(read()));
        return typeof stop === 'function' ? stop : () => {};
      } catch {
        return () => {};
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        services.ctx = ctx;
        ctx.effect(insertStyles, 'novel-studio: workbench styles');
        ctx.effect(() => followLocale(ctx), 'novel-studio: follow shell language');
        ctx.effect(() => () => { services.ctx = null; }, 'novel-studio: forget shell ctx');

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'novel-studio',
              order: 40,
              label: () => t.title,
            },
            Icon
          )
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'novel-studio' }, Workbench)
        );
      },
    };
  },
});
