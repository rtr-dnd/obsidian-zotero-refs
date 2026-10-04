# Zotero Refs (Obsidian plugin)

Zotero の「Copy bibliography」でコピーした書誌から、vault の `00_Refs/` にある文献ノートを開く（なければ作成する）Obsidian プラグイン。Android の Obsidian で使うことを想定している。

## 使い方

Zotero で論文を選び **Copy bibliography** でコピーしてから、次のどれかで開く。書誌の DOI でノートを探して開き、なければ doi.org から書誌情報を取得してノートを作る。ノートは新しいタブで開く（すでに開いていればそのタブへ移る）。

- **リボンの 📋**（コマンド「クリップボードの書誌からノートを開く」）
- **共有メニュー**: `obsidian://zotero-refs?vault=<vault名>&text=<書誌>` を開く（HTTP Shortcuts などから）
- **自動確認**（設定でオンにしたときだけ）: Obsidian に戻ったときにクリップボードを確認する。DOI と出版年を含む書誌らしいテキストにだけ反応し、直前 10 秒以内に編集していたら勝手に切り替えず「開く」ボタン付きの通知を出す

DOI のない書誌は、確認の通知から「題名で開く」を押したときだけ題名で照合・作成する。

## ノートの書式

ファイル名は `著者姓_年_題名先頭50字.md`。Mac の Zotero Integration（テンプレート `00_Refs/00_zotero_temp.md`）と同じ書式で出力するので、どちらで作っても同じノートになる。`## コメント` 内の `%% begin comments %%` ～ `%% end comments %%` は Zotero Integration で再インポートしても保持される。

## インストール

ビルド不要（`main.js` がそのままプラグイン本体）。vault の `.obsidian/plugins/zotero-refs-sync` からこのリポジトリへシンボリックリンクを張る。

```sh
ln -s /Users/ritar/dev/obsidian-zotero-refs <vault>/.obsidian/plugins/zotero-refs-sync
```
