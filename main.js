'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, normalizePath } = require('obsidian');

const CLIPBOARD_THROTTLE_MS = 2 * 1000;
// この時間内に編集していたら、自動ではノートを切り替えない
const EDIT_GRACE_MS = 10 * 1000;

const DEFAULT_SETTINGS = {
  folder: '00_Refs',
};

// 端末ごとに持つ値
const LS = {
  clipWatch: 'zrs-clipboard-watch',
  clipText: 'zrs-last-clipboard-text',
  clipStatus: 'zrs-last-clipboard-status',
};

module.exports = class ZoteroRefs extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.lastClipboardAt = 0;
    this.lastEditAt = 0;
    // Web API 連携をやめたので、以前の版が端末に保存した APIキーなどを消す
    for (const key of ['api-key', 'user-id', 'username', 'auto-sync', 'last-version', 'last-synced-at', 'last-check']) {
      this.setLocal(`zrs-${key}`, null);
    }

    this.addSettingTab(new ZoteroRefsSettingTab(this.app, this));

    this.addCommand({
      id: 'from-clipboard',
      name: 'クリップボードの書誌からノートを開く',
      callback: () => this.openFromClipboard(),
    });
    this.addRibbonIcon('clipboard-paste', 'Zotero: クリップボードの書誌からノートを開く', () => this.openFromClipboard());

    // 共有メニュー → HTTP Shortcuts などから obsidian://zotero-refs?text=<書誌> で呼ぶ
    this.registerObsidianProtocolHandler('zotero-refs', (params) =>
      this.openFromCitation(params.text ?? params.doi ?? '')
    );

    // 書きかけのノートを自動で切り替えないよう、最後に編集した時刻を覚えておく
    this.registerEvent(this.app.workspace.on('editor-change', () => (this.lastEditAt = Date.now())));

    this.app.workspace.onLayoutReady(() => {
      this.checkClipboard();
      // Android ではアプリ切替から戻っても再起動にならないので、前面に戻ったときに確認する
      this.registerDomEvent(document, 'visibilitychange', () => {
        if (document.visibilityState === 'visible') this.checkClipboard();
      });
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  local(key) {
    return this.app.loadLocalStorage(key);
  }

  setLocal(key, value) {
    this.app.saveLocalStorage(key, value);
  }

  // ---------- クリップボード ----------

  clipboardWatchEnabled() {
    return this.local(LS.clipWatch) === 'true';
  }

  async readClipboard() {
    try {
      return await navigator.clipboard.readText();
    } catch (e) {
      const cap = window.Capacitor?.Plugins?.Clipboard;
      if (!cap) throw e;
      return (await cap.read()).value ?? '';
    }
  }

  recordClipboard(result) {
    this.setLocal(LS.clipStatus, `${new Date().toLocaleString()} / ${result}`);
  }

  // 自動確認（オンのときだけ）: Zotero の「Copy bibliography」でコピーした書誌があれば、そのノートを開く
  async checkClipboard() {
    if (!this.clipboardWatchEnabled()) return;
    const now = Date.now();
    if (now - this.lastClipboardAt < CLIPBOARD_THROTTLE_MS) return;
    this.lastClipboardAt = now;

    let text;
    try {
      text = (await this.readClipboard())?.trim();
    } catch (e) {
      this.recordClipboard(`読み取り失敗: ${e.message ?? e}`);
      return;
    }
    if (!looksLikeCitation(text) || text === this.local(LS.clipText)) return;
    this.setLocal(LS.clipText, text);
    this.recordClipboard(`DOI ${extractDoi(text)}`);
    await this.openFromCitation(text, { auto: true });
  }

  async openFromClipboard() {
    try {
      const text = (await this.readClipboard())?.trim();
      this.setLocal(LS.clipText, text);
      await this.openFromCitation(text ?? '');
    } catch (e) {
      this.fail('クリップボードの読み取り', e);
    }
  }

  // ---------- ノート ----------

  async openFromCitation(text, { auto = false } = {}) {
    const doi = extractDoi(text);
    const title = extractTitle(text);
    if (doi) return this.openOrCreate({ doi, title }, { auto });
    if (!title) {
      new Notice('Zotero: 書誌に DOI が見つかりません');
      return;
    }
    // DOI がないときは題名だけで照合・作成するので、確認してから進める
    this.noticeWithAction(`Zotero: DOI がありません。題名で開きますか？\n${title}`, '題名で開く', () =>
      this.openOrCreate({ doi: null, title })
    );
  }

  async openOrCreate({ doi, title }, { auto = false } = {}) {
    try {
      let file = this.findNote({ doi, title });
      if (!file) {
        const fetched = doi ? await this.fetchDoi(doi).catch((e) => console.warn('[zotero-refs]', e)) : null;
        file = await this.writeNote(fetched ?? { title: title ?? doi, DOI: doi ?? '', creators: [] });
        new Notice(`Zotero: ノートを作成しました\n${file.basename}`);
      }
      // 自動確認のときは、書きかけのノートがあれば勝手に切り替えずボタンで開いてもらう
      if (auto && Date.now() - this.lastEditAt < EDIT_GRACE_MS) {
        this.noticeWithAction(`Zotero: ${file.basename}`, '開く', () => this.openFile(file));
        return;
      }
      await this.openFile(file);
    } catch (e) {
      this.fail('書誌からのノート作成', e);
    }
  }

  noticeWithAction(message, label, action) {
    const notice = new Notice(
      createFragment((f) => {
        f.createDiv({ text: message });
        f.createEl('button', { text: label }).addEventListener('click', () => {
          notice.hide();
          action();
        });
      }),
      15 * 1000
    );
  }

  // doi.org のコンテントネゴシエーションで CSL-JSON を取る
  async fetchDoi(doi) {
    const res = await requestUrl({
      url: `https://doi.org/${encodeURI(doi)}`,
      headers: { Accept: 'application/vnd.citationstyles.csl+json' },
    });
    return cslToItem(res.json, doi);
  }

  frontmatter(file) {
    return this.app.metadataCache.getFileCache(file)?.frontmatter;
  }

  // DOI → 題名の順で既存ノートを探す
  findNote({ doi, title }) {
    const prefix = normalizePath(this.settings.folder) + '/';
    const entries = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix))
      .map((file) => ({ file, fm: this.frontmatter(file) ?? {} }));
    const nd = normalizeDoi(doi);
    const nt = normalizeTitle(title);
    return (
      (nd && entries.find((e) => normalizeDoi(e.fm.doi) === nd)?.file) ||
      (nt && entries.find((e) => normalizeTitle(e.fm.title) === nt)?.file) ||
      null
    );
  }

  // 今のタブは書きかけかもしれないので置き換えない。開いているタブがあればそこへ移る
  async openFile(file) {
    const { workspace } = this.app;
    const leaf = workspace.getLeavesOfType('markdown').find((l) => l.view.file?.path === file.path);
    if (leaf) {
      workspace.setActiveLeaf(leaf, { focus: true });
      return;
    }
    await workspace.getLeaf('tab').openFile(file);
  }

  async writeNote(data) {
    const folder = normalizePath(this.settings.folder);
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);

    let path = normalizePath(`${folder}/${noteName(data)}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${noteName(data)} (${Date.now()}).md`);
    return this.app.vault.create(path, render(data));
  }

  fail(what, e) {
    console.error('[zotero-refs]', e);
    new Notice(`Zotero: ${what}に失敗しました\n${e.message ?? e}`, 8000);
  }
};

// ---------- helpers ----------

// 書誌の書式によらず DOI を拾う（末尾の句読点は除く）
function extractDoi(text) {
  return (text ?? '').match(/\b10\.\d{4,9}\/[^\s"<>]+/)?.[0].replace(/[.,;:)\]]+$/, '') ?? null;
}

// 自動確認で反応するのは Zotero の書誌らしいテキストだけ（DOI と出版年があり、長すぎない）
function looksLikeCitation(text) {
  const doi = extractDoi(text);
  return !!doi && text.length > doi.length + 20 && text.length <= 1000 && /\b(19|20)\d{2}\b/.test(text);
}

// Chicago など題名を引用符で囲む書式から題名を拾う
function extractTitle(text) {
  return (text ?? '').match(/[“"]([^”"]+)[”"]/)?.[1].trim().replace(/[,.]$/, '') || null;
}

function normalizeDoi(doi) {
  return String(doi ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '');
}

function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Mac の Zotero Integration で作るノートと item_type をそろえるため Zotero の項目タイプ名に寄せる
const CSL_TO_ZOTERO_TYPE = {
  'journal-article': 'journalArticle',
  'article-journal': 'journalArticle',
  'proceedings-article': 'conferencePaper',
  'paper-conference': 'conferencePaper',
  'posted-content': 'preprint',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'book-chapter': 'bookSection',
  chapter: 'bookSection',
  dissertation: 'thesis',
  thesis: 'thesis',
  report: 'report',
  dataset: 'dataset',
};

function cslToItem(c, doi) {
  const parts = (c.issued ?? c.published)?.['date-parts']?.[0] ?? [];
  return {
    itemType: CSL_TO_ZOTERO_TYPE[c.type] ?? c.type ?? '',
    title: [].concat(c.title ?? '')[0],
    creators: (c.author ?? []).map((a) => (a.literal ? { name: a.literal } : { firstName: a.given ?? '', lastName: a.family ?? '' })),
    publicationTitle: [].concat(c['container-title'] ?? '')[0],
    volume: c.volume ?? '',
    issue: c.issue ?? '',
    pages: c.page ?? '',
    // Mac の Zotero Integration と同じく、月日が欠けていれば 01 で埋める
    date: parts.length ? [parts[0], parts[1] ?? 1, parts[2] ?? 1].map((p) => String(p).padStart(2, '0')).join('-') : '',
    DOI: c.DOI ?? doi,
    url: c.URL ?? '',
    abstractNote: (c.abstract ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^Abstract\s*/i, ''),
  };
}

function creatorName(c) {
  return c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' ');
}

// 例: Smith_2024_Attention Is All You Need
function noteName(d) {
  const c = d.creators?.[0];
  const author = c ? c.lastName ?? c.name : 'NoAuthor';
  const year = (d.date ?? '').match(/\d{4}/)?.[0] ?? 'nd';
  const title = (d.title || d.DOI).slice(0, 50);
  return [author, year, title]
    .join('_')
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function render(d) {
  const q = (s) => JSON.stringify(s ?? '');
  const year = (d.date ?? '').match(/\d{4}/)?.[0] ?? '';
  const authors = (d.creators ?? []).map((c) => q(`[[${creatorName(c)}]]`));
  return [
    '---',
    `title: ${q(d.title)}`,
    `authors: [${authors.join(', ')}]`,
    `journal: ${q(d.publicationTitle ? `[[${d.publicationTitle}]]` : '')}`,
    `volume: ${q(d.volume)}`,
    `issue: ${q(d.issue)}`,
    `pages: ${q(d.pages)}`,
    `date: ${q(d.date)}`,
    `year: ${q(year)}`,
    `doi: ${q(d.DOI)}`,
    `url: ${q(d.url)}`,
    `item_type: ${q(d.itemType)}`,
    'tags: []',
    '---',
    `# ${d.title ?? ''}`,
    d.DOI ? `[DOI](https://doi.org/${d.DOI})` : '',
    '',
    '## 抄録',
    d.abstractNote ?? '',
    '',
    '---',
    '## コメント',
    // Zotero Integration の persist ブロック。Mac で再インポートしてもこの中は残る
    '%% begin comments %%',
    '- ',
    '%% end comments %%',
    '',
  ].join('\n');
}

// ---------- UI ----------

class ZoteroRefsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName('ノートのフォルダ')
      .addText((t) =>
        t.setValue(p.settings.folder).onChange(async (v) => {
          p.settings.folder = v.trim() || DEFAULT_SETTINGS.folder;
          await p.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('前面に戻ったときにクリップボードを自動確認')
      .setDesc('オンにすると、Obsidian に戻ったときにクリップボードの書誌（DOI 入り）のノートを開きます。オフ（初期値）のときは 📋 ボタンか共有メニュー（obsidian://zotero-refs）から開きます。この端末にだけ保存されます')
      .addToggle((t) =>
        t.setValue(p.clipboardWatchEnabled()).onChange((v) => p.setLocal(LS.clipWatch, v ? 'true' : 'false'))
      );

    new Setting(containerEl)
      .setName('最後のクリップボード確認')
      .setDesc(p.local(LS.clipStatus) ?? 'まだ確認していません');
  }
}
