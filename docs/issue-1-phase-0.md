# Issue #1 — Web AI Bridge Phase 0

対象: [Issue #1 / SRS v0.4](https://github.com/kfuruichi0920/vcex/issues/1)。
2026-10-11、初期対象サービスはまだ存在しないため、ユーザー確認に基づき仮 React チャットで方式検証を実施。
これは親 Issue 全体の完了報告ではない。実サービスでの Phase 0 終了条件は対象サイト作成後に確認する。

## 構成

| 場所                                          | 役割                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `extensions/web-ai-bridge/src/extension.ts`   | サイドバー、送信前プレビュー、設定、ジョブ制御                       |
| `src/context.ts`                              | 最後のエディタから選択範囲／全文実ファイルを準備                     |
| `src/runner.ts`                               | 状態遷移、添付 → 送信 → 明示完了 → 保存、取消と後処理                |
| `src/adapter.ts`                              | サイト固有 interface と仮サイト用 `MockChatAdapter`                  |
| `src/edge.ts`                                 | CDP 接続／専用 Edge 起動、自分のタブだけを閉じる処理                 |
| `src/clipboard.ts`, `resources/clipboard.ps1` | 標準 PowerShell + WinForms の STA クリップボード helper              |
| `src/log.ts`                                  | ローカル日時、衝突回避、質問／回答／状態の Markdown 化               |
| `tools/mock-chat`                             | 外部 LLM に送信しない React チャット、受理状態と Markdown 応答を模擬 |

Playwright は動的 require と内部相対パスを使用するため、`playwright-core` を `dist/node_modules` に構造を保持してコピーする。
一般の雛形ビルドは変更せず、この拡張機能だけ専用ビルドにする。実行時は Edge の `msedge` channel を指定し、ブラウザをダウンロードしない。
PowerShell helper はファイルパスまたは PNG bytes の base64 を stdin で受け渡す。PNG の一時ファイルは作らない。
クリップボードの完全復元は保証しない。ユーザー質問・添付内容を診断エラーへ出力しない。

## 検証環境・実行

- 開発: Node.js 22.12.0 / npm 11.6.1 / Windows。
- 実行: ユーザー指定の VS Code Portable 1.141.0（Extension Host Node 24.21.0）と既存 Edge 156.0.4314.15。
- 通常起動中の Edge に CDP port 指定はなかった。再起動や既存プロファイル変更は行わず、検証専用の別プロファイルを起動。
- Portable テストは VSIX を展開した独立フォルダを使い、PATH を `Windows/System32` のみにして実行。user-data・extensions・Edge profile は `.test-artifacts/` 配下へ分離。

```powershell
npm ci
npm run check
npm run test:bridge
npm run package --workspace=extensions/web-ai-bridge
npm run test:portable -- "C:\work\01_editor\VSCode-win32-x64-1.141.0\Code.exe"
npm audit
```

`test:bridge` は先に `npm run build` が必要。`test:portable` は最新の VSIX と仮サイトの build を使用する。
テストが起動した Edge・VS Code は終了する。クリップボード操作中の他アプリのコピー操作は避ける。
証跡は `.test-artifacts/edge-*/results.json`、`portable-*/portable-results.json`、Markdown ログと画面 PNG。
テスト用プロファイルとキャッシュもここへ残すため、データ残存の評価対象として扱う。

## 方式検証結果

| 項目              | 結果・限界                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| POC-01 CDP        | 専用検証 Edge への CDP 接続、新規タブ、処理後の切断を確認。既存の検証用別タブは維持                                             |
| POC-02 認証状態   | 仮サイトの localStorage が新規タブから参照できることを確認。実サービスのログインは未検証                                        |
| POC-03 PNG        | Headed Edge で実 Ctrl+V による画像のメモリ貼り付けを確認                                                                        |
| POC-04 Office/PDF | ファイル拡張子別の CF_HDROP 転送を確認。テストデータは転送検証用で、実 Office/PDF の解析・形式受理は未検証                      |
| POC-05 複数添付   | PDF/DOCX/XLSX/PPTX の4ファイル＋PNGの5添付を確認。件数・カード情報を確認してから1回だけ送信                                     |
| POC-06 D&D        | ファイル選択への案内を実装。画像の直接 Webview 貼り付け UI は未実装                                                             |
| POC-07 Headless   | この環境ではファイル Ctrl+V が受理されず `UPLOAD_FAILED` で中断。別方式への自動切替はない。非前面・実サービスごとの可否は未検証 |
| POC-08 回答       | 明示 complete 状態後に Markdown を取得。短い安定だけでは完了にせず、タイムアウトは未取得として保存                              |
| POC-09 Portable   | VSIX 同梱物で起動し、コンテキスト取得、ネイティブ貼り付け、ログ保存と自動表示を確認。データレス PC は未検証                     |
| POC-10 利用条件   | 仮のローカルサイトのみ。実サービスの利用条件は対象確定後に確認                                                                  |

異常系: 添付拒否で送信0回、認証要求、回答タイムアウト、実行取消、送信成否不明で送信試行1回・再送0回を確認。
Portable の実画面では質問入力 → 38,000文字警告 → 内容変更 → プレビュー → キーボードによる送信 → 完了まで確認。
生成VSIXは約3.1 MB、展開した拡張機能本体は約13.7 MBで30 MB目標以内（テスト追加物・プロファイル・ログ・キャッシュは別）。
メモリ利用の継続的な測定・負荷評価は後続フェーズで実施する。

## 後続で必要な作業

1. 本物の React チャット確定後、DOM・新規会話・ログイン・添付状態・回答 Markdown の契約を決定し、専用 Adapter を実装する。
2. 実際の Office/PDF 内容とサービス側上限、ログイン状態、通常利用 Edge の許可済み CDP 構成で再検証する。
3. 外部 Markdown 定型プロンプト・`/`補完・`@`ファイル補完、D&D／画像直接入力、実サービスの Markdown 抽出を追加する。
4. タイムアウト・添付上限・ログ規則の最終値、クリップボード復元範囲、メモリ・キャッシュ残存、公開用情報を確定する。

## 参照資料

- [Edge DevTools Protocol / CDP](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/)
- [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)
- [VS Code Extension Tests](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
