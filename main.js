'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, normalizePath, Platform } = require('obsidian');

const CLIPBOARD_THROTTLE_MS = 2 * 1000;

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

    this.app.workspace.onLayoutReady(() => {
      this.checkClipboard('起動');
      // Android ではアプリ切替から戻っても再起動にならないので、前面に戻ったときにも確認する。
      // WebView によって発火するイベントが違うので複数拾い、スロットルで1回にまとめる
      this.registerDomEvent(document, 'visibilitychange', () => {
        if (document.visibilityState === 'visible') this.checkClipboard('visibilitychange');
      });
      this.registerDomEvent(document, 'resume', () => this.checkClipboard('resume'));
      this.registerDomEvent(window, 'focus', () => this.checkClipboard('focus'));
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
    const v = this.local(LS.clipWatch);
    return v == null ? Platform.isMobile : v === 'true';
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

  recordClipboard(trigger, result) {
    this.setLocal(LS.clipStatus, `${new Date().toLocaleString()} / ${trigger} / ${result}`);
  }

  // Zotero の「Copy bibliography」でコピーした書誌がクリップボードにあれば、そのノートを開く
  async checkClipboard(trigger) {
    if (!this.clipboardWatchEnabled()) return;
    const now = Date.now();
    if (now - this.lastClipboardAt < CLIPBOARD_THROTTLE_MS) return;
    this.lastClipboardAt = now;

    let text;
    try {
      text = (await this.readClipboard())?.trim();
    } catch (e) {
      this.recordClipboard(trigger, `読み取り失敗: ${e.message ?? e}`);
      return;
    }
    if (!text || !extractDoi(text)) return this.recordClipboard(trigger, 'DOIなし');
    if (text === this.local(LS.clipText)) return this.recordClipboard(trigger, '処理済みの書誌');
    this.setLocal(LS.clipText, text);
    this.recordClipboard(trigger, `DOI ${extractDoi(text)}`);
    await this.openFromCitation(text);
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

  async openFromCitation(text) {
    try {
      const doi = extractDoi(text);
      const title = extractTitle(text);
      if (!doi && !title) {
        new Notice('Zotero: 書誌から DOI も題名も読み取れませんでした');
        return;
      }
      const existing = this.findNote({ doi, title });
      if (existing) {
        await this.openFile(existing);
        return;
      }
      const fetched = doi ? await this.fetchDoi(doi).catch((e) => console.warn('[zotero-refs]', e)) : null;
      const data = fetched ?? { title: title ?? doi, DOI: doi ?? '', creators: [] };
      const file = await this.writeNote(data);
      new Notice(`Zotero: ノートを作成しました\n${file.basename}`);
      await this.openFile(file);
    } catch (e) {
      this.fail('書誌からのノート作成', e);
    }
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

  async openFile(file) {
    await this.app.workspace.getLeaf(false).openFile(file);
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
      .setName('前面に戻ったときにクリップボードを確認')
      .setDesc('Zotero の「Copy bibliography」でコピーした書誌に DOI があれば、そのノートを開きます（なければ作成）。この端末にだけ保存されます')
      .addToggle((t) =>
        t.setValue(p.clipboardWatchEnabled()).onChange((v) => p.setLocal(LS.clipWatch, v ? 'true' : 'false'))
      );

    new Setting(containerEl)
      .setName('最後のクリップボード確認')
      .setDesc(p.local(LS.clipStatus) ?? 'まだ確認していません');
  }
}
