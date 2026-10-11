# VS Code 拡張機能の開発ワークスペース

複数の拡張機能を個別のプロジェクトとして管理し、共通コードと開発設定を共有します。
初期の雛形は **デスクトップ版 VS Code 向けの TypeScript 拡張機能**です。

```text
extensions/          拡張機能ごとのプロジェクト（それぞれ個別に VSIX 化）
packages/shared/     拡張機能間で共有する TypeScript コード
templates/extension/ 新しい拡張機能の雛形
scripts/             共通ビルド・プロジェクト生成
.vscode/             ルートからの検証・デバッグ設定
tools/mock-chat/     Web AI Bridge の検証用 React チャット
```

## セットアップ

Node.js 22.12 以上の 22 系、npm 11 系、VS Code 1.100 以上を使用します。
この環境では Node.js 22.12.0 / npm 11.6.1 を使用しています。
依存関係はルートで一括管理し、`package-lock.json` を Git に含めます。

```powershell
npm ci
npm run check
```

VS Code でこのフォルダを開き、推奨される ESLint / Prettier 拡張機能を必要に応じてインストールしてください。
依存ツールはプロジェクト内にインストールするため、グローバルな追加インストールは不要です。

## 拡張機能の追加

ルートで実行します。名前は小文字英字で始まる英数字・ハイフン（64文字以内）です。
既存フォルダには上書きしません。

```powershell
npm run new:extension -- my-extension
npm install
npm run check
```

`extensions/my-extension` にソース、manifest、デバッグ設定が生成されます。
最初は `my-extension: Hello` コマンドで共有コードを使用したメッセージ表示を確認できます。
実際の機能に合わせて `src/extension.ts` と `package.json` を編集してください。

## 開発・デバッグ

ルートを VS Code で開いて F5 を押し、対象フォルダ名を入力します。
起動前に全拡張機能をビルドし、指定した拡張機能をデバッグします。
Extension Development Host が起動したら、コマンドパレットで対象のコマンドを実行します。
ブレークポイントは TypeScript のソースに設定できます。

個別の `extensions/my-extension` を VS Code で開いて F5 を押す方法もあります。
いずれもビルドは起動直前に実行します。変更の反映には開発ホストの再起動が必要です。

```powershell
# 特定の拡張機能
npm run build --workspace=extensions/my-extension
npm run watch --workspace=extensions/my-extension
npm run typecheck --workspace=extensions/my-extension

# リポジトリ全体
npm run check
npm run format
```

`check` は全 workspace の型検査、ESLint、整形確認、生成スクリプトのテスト、ビルドを実行します。
拡張機能の実機動作は F5 で確認してください。Extension Host を使う自動 E2E テストは各機能の開発時に追加します。

## コード・資産の共有

`packages/shared/src/index.ts` に共通処理を追加し、拡張機能から利用します。
初期状態の `createGreeting` は参照方法を示す最小例です。

```typescript
import { createGreeting } from '@vcex/shared';
```

npm workspaces が共通パッケージをローカルでリンクします。
esbuild が共通コードと JavaScript の依存を各拡張機能の `dist/extension.js` にまとめるため、配布先にこのリポジトリは不要です。
`vscode` は Extension Host が提供します。
共通パッケージを増やす場合は `packages/<名前>/package.json` を作り、利用側の `dependencies` に同じ名前・バージョンを指定してルートで `npm install` してください。
共通コードの変更後は利用する各拡張機能を再ビルドします。

画像・Webview 用ファイルなど実行時に必要な資産は、各拡張機能の `media/` へ配置してください。
共有する静的資産を追加した際は、そのコピー処理をビルドへ追加します。
native module や動的に読み込むファイルなどバンドルできない依存を追加する際は、ビルドと VSIX の収録設定を個別に調整してください。

## VSIX の作成とローカルインストール

```powershell
npm run package --workspace=extensions/my-extension
code --install-extension extensions/my-extension/my-extension-0.0.1.vsix
```

型検査と本番ビルドの後、拡張機能フォルダに VSIX を生成します。
`.vscodeignore` は manifest、README、CHANGELOG、LICENSE、バンドル、`media/` のみを収録する設定です。
ソース・node_modules・開発設定を含めず、バンドル済みのため `--no-dependencies` を指定しています。

雛形の publisher はローカル開発用の `local-dev` です。
配布条件は未指定なので LICENSE は作成していません。
現状の package コマンドはローカル検証用として repository・license の未設定を許容します。
Marketplace 公開前には publisher、説明、repository、ライセンスを設定し、
`--allow-missing-repository --skip-license` を外して内容を確認してください。
公開用の認証情報や自動公開の設定は含めていません。

## 参考

実装済みの拡張機能: [Web AI Bridge（Phase 0）](extensions/web-ai-bridge/README.md)。
方式検証の範囲・手順は [Issue #1 対応記録](docs/issue-1-phase-0.md) を参照してください。

- [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/)
- [VS Code 拡張機能のバンドル](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
- [拡張機能の公開・VSIX 作成](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
