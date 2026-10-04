# Zotero Refs (Obsidian plugin)

Zotero の「Copy bibliography」でコピーした書誌から、vault の `00_Refs/` にある文献ノートを開く（なければ作成する）Obsidian プラグイン。Android の Obsidian で使うことを想定している。

## 使い方

- Zotero で論文を選び **Copy bibliography** → Obsidian に切り替えると、クリップボードの書誌に含まれる DOI でノートを探して開く。なければ doi.org から書誌情報を取得してノートを作る。
- 自動で反応しないとき（DOI のない書誌など）は、リボンの 📋 またはコマンド「クリップボードの書誌からノートを開く」を使う。題名でも照合する。
- `obsidian://zotero-refs?text=<書誌>` でも呼び出せる（共有メニュー → HTTP Shortcuts などから）。

## ノートの書式

ファイル名は `著者姓_年_題名先頭50字.md`。Mac の Zotero Integration（テンプレート `00_Refs/00_zotero_temp.md`）と同じ書式で出力するので、どちらで作っても同じノートになる。`## コメント` 内の `%% begin comments %%` ～ `%% end comments %%` は Zotero Integration で再インポートしても保持される。

## インストール

ビルド不要（`main.js` がそのままプラグイン本体）。vault の `.obsidian/plugins/zotero-refs-sync` からこのリポジトリへシンボリックリンクを張る。

```sh
ln -s /Users/ritar/dev/obsidian-zotero-refs <vault>/.obsidian/plugins/zotero-refs-sync
```
