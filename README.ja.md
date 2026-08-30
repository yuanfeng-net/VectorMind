[简体中文](README.zh-CN.md) | [English](README.md) | **日本語** | [한국어](README.ko.md) | [繁體中文](README.zh-TW.md)

# VectorMind MCP

VectorMind は、AI コーディングアシスタント向けのローカルプロジェクトメモリ MCP です。要件、意思決定、変更理由、プロジェクト規約、ファイル状態をプロジェクト内に保存し、長期開発におけるコンテキスト消失、プロジェクト間の混線、古いロジックへの回帰を抑えます。

現在のバージョン：`1.1.6`

## 主な機能

- **プロジェクトコンテキストの復元**：現在の目標に関連する概要、要件、意思決定、規約、メモリを取得します。
- **要件の明確化を支援**：MCP server instructions により、完全な承認がある場合のみ AI が行動し、不足時はユーザーへ確認するよう促します。
- **変更範囲の制約**：編集前に要件項目、予定ファイル、巨大ファイルのガバナンス要件を確認します。
- **変更意図の記録**：変更ファイル、実装理由、検証結果、残課題を対応する要件へ記録します。
- **要件ライフサイクルの管理**：直列タスク、明示的な並列タスク、完了済みタスクの再開、検証結果の更新に対応します。
- **権威ある意思決定の更新**：新しい決定で古い要件やメモリを supersede し、後続セッションが古い規則に従うことを防ぎます。
- **複数プロジェクトの分離**：メモリ、pending buffer、インデックス、データベースを `project_root` ごとに分離します。
- **安全なファイル読み取り**：canonical realpath 検証により、シンボリックリンクや junction を使った境界外アクセスを拒否します。
- **信頼できない内容と操作のスキャン**：ファイル、メモリ、`grep`、シンボル検索に `security_scan` を付与します。高信頼度の機密情報流出だけを具体的な操作プリフライトで遮断し、通常の文書、記事、テストデータ、明示された一般アップロードは advisory のままです。
- **安全な SSH デプロイ準備**：`prepare_secure_ssh` はホスト内部でサーバー設定を読み、対象メタデータと SSH 設定パスだけを返します。パスワードや秘密鍵は返しません。利用可能なホスト鍵を優先し、なければ一時 Ed25519 鍵を生成してパスワード認証を無効化し、公開鍵の事前登録を求めます。
- **長期セッションのチェックポイント**：上限付き・バージョン管理された checkpoint を作成し、読み取り専用で復元・比較します。
- **メモリ品質の診断**：競合、重複、過大 checkpoint、古いインデックス、孤立メモリを検査します。
- **コンテキスト量の制御**：既定では簡潔なツールセットと出力を使い、大きな結果でも主要 ID と完了状態を保持します。

完全な一覧は [能力マトリクス（簡体字中国語）](docs/capability-matrix.md) を参照してください。

## クイックインストール

推奨方法は、プロジェクト URL を AI コーディングアシスタントへ送り、インストールと設定を自動で完了させることです。

```text
VectorMind MCP をインストールして設定してください：
https://github.com/yuanfeng-net/VectorMind

現在使用中の AI コーディングクライアントを自動判別し、インストール、MCP 設定、動作確認まで完了してください。
必要な権限がない場合を除き、手動でコマンドを実行させないでください。
```

通常は GitHub URL と「インストールして」という指示だけで十分です。AI が現在のクライアントを判別し、MCP 設定を更新して利用可能性を検証します。

## 手動インストールと設定（任意）

Node.js `20.19.0` 以降が必要です。

MCP を直接実行：

```bash
npx -y @coreyuan/vector-mind
```

またはグローバルインストール：

```bash
npm install -g @coreyuan/vector-mind
```

グローバルインストールでは次の 3 コマンドが利用できます。

```text
vector-mind        # MCP stdio サーバー
vector-mind-admin  # 本番モード管理パネル
rtk                # RTK 互換エントリ
```

### Codex の手動設定

`~/.codex/config.toml` に追加します。

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
```

設定後に Codex を再起動し、新しいタスクで使用してください。

### Claude Desktop の手動設定

```json
{
  "mcpServers": {
    "vector-mind": {
      "command": "npx",
      "args": ["-y", "@coreyuan/vector-mind"]
    }
  }
}
```

## 管理パネル

MCP のインストールと設定後、管理パネルは `vector-mind` MCP プロセスとともにバックグラウンドで自動起動します。別途サービスを起動する必要はありません。

```text
http://127.0.0.1:16860
```

トラブルシューティング用に手動起動もできます。

```bash
vector-mind-admin
```

既定のアドレスは [http://127.0.0.1:16860](http://127.0.0.1:16860) です。既定ではループバックだけをリッスンし、ループバック要求から現在のページ用セッションを作るため、トークンの手入力は不要です。

ページの読み込み・更新時に、Codex デスクトップの `$CODEX_HOME/.codex-global-state.json` からローカルプロジェクト一覧を読み取り専用で同期し、Codex の順序で表示します。存在しないディレクトリは無視され、手動追加またはディレクトリスキャンで見つかったプロジェクトは削除されません。

ソースから実行：

```bash
npm ci
npm run build
npm run admin:start
```

開発モードでは Vite ミドルウェアと HMR を使用します。

```bash
npm run admin:dev
```

利用可能な環境変数：

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `VECTORMIND_ADMIN_HOST` | `127.0.0.1` | 管理サービスのリッスンアドレス |
| `VECTORMIND_ADMIN_PORT` | `16860` | 管理サービスポート |
| `VECTORMIND_ADMIN_TOKEN` | なし | 非ループバックでのリッスン時に必須 |
| `VECTORMIND_ADMIN_AUTO_START` | `true` | `false`、`0`、`no`、`off`、`disabled` で MCP 連動の自動起動を無効化 |

非ループバックでリッスンする場合、起動時に `VECTORMIND_ADMIN_TOKEN` が必須です。トークンは `/api/config` から返されず、ブラウザーで入力した値は現在のタブの `sessionStorage` のみに保存されます。保護 API はトークンと同一オリジンの `Origin` を検証し、`Origin` がなくても検証を回避できません。

詳細は [管理パネル文書（簡体字中国語）](admin-panel/README.md) を参照してください。

## 使い方

VectorMind のツールコマンドを覚えたり手入力したりする必要はありません。通常どおり自然言語で目標、制約、期待結果を説明すれば、必要に応じて AI クライアントが関連コンテキストを復元し、変更範囲を確認し、変更理由を記録します。

同じセッションで無関係な複数タスクを並行処理する場合は、並行保持するタスクと、それぞれのプロジェクト・目標を AI に明示してください。内部の要件 ID とツール呼び出しはクライアントが管理します。

VectorMind の品質シグナルはコンテキスト証拠であり、モデルやユーザーに代わって判断しません。

### セキュリティスキャンの境界と負荷

セキュリティスキャンはプロンプトインジェクション、認証情報アクセス、ホスト探索、ローカル機密データの流出を検出します。他の MCP ツールを支配したり、AI の推論・設計・実装方向を決めたりしません。

- ファイル、メモリ、`grep`、セマンティック検索、シンボル検索の結果は `advisory_only`、`coverage`、`complete` を持つ advisory シグナルです。
- `preflight_operation_scope` が高信頼度の認証情報流出を検出した具体的操作だけに blocker を返します。MCP が書いた decision、requirement、note、convention にはホスト認証済みのユーザー由来情報がないため warning にしかならず、現在の要求を上書きしたり `safe_to_proceed` を false にしたりできません。通常の読み取り、検索、コード生成などは影響を受けません。
- デプロイ説明、ファイル一覧、`--exclude`、リモートパス、`ssh/scp -i` の identity file はアップロード内容として扱いません。ローカル `.env` がデプロイ元なら既定で遮断します。信頼対象は、ホスト起動変数 `VECTORMIND_DEPLOYMENT_HOST` に登録された正規化済み IPv4/IPv6 リテラル、または `prepare_secure_ssh` が生成・登録・ハッシュ検証した `-F` 設定に限定されます。`server.txt` 単独では信頼を確立できず、不正な環境値は fail closed です。`.env` または追跡可能なコピー・改名・エンコード・アーカイブ派生物が、その IP へ信頼済みシステム OpenSSH/SSH-style rsync だけで送られる場合に限り例外となります。リンク派生物、SSH 秘密鍵、クラウド認証情報、`server.txt`、ホスト環境変数は例外になりません。
- 登録済み `-F` 設定がない機密 SSH アップロード時だけ `ssh -G` を実行します。実ユーザー、ポート、安全な `-o` を含めて検証し、最終 `hostname` が対象 IP、公開鍵認証と `BatchMode`、ホスト鍵検証を必須にします。パスワード、keyboard-interactive、制御ソケット再利用、Agent/stdio/ポート転送、ジャンププロキシ、`ProxyCommand`、`LocalCommand`、`KnownHostsCommand`、空の known-host ファイルは禁止です。通常の build/test/git や登録済み設定によるデプロイでは実行しません。
- 未変更の実行検索環境で見つかる標準コマンド名と、`/usr/bin`、`/bin`、Windows System32 OpenSSH の明示パスを受け入れます。裸のコマンド名はファイルハッシュ検証済みとは見なしません。`./scp`、`/tmp/ssh`、偽装スクリプト、独自 SSH/SCP/SFTP、制御ソケット、転送、危険な `-o`、独自 rsync transport は例外対象外です。標準 `rsync -e ssh`、`/usr/bin/ssh`、安全な `RSYNC_RSH=ssh` は利用できます。
- データフローはコマンド順に、変数化された copy/move、シンボリック・ハードリンク、base64、tar/zip/7z、`dd`、機密環境変数の書き込み、スクリプト/PowerShell の書き込み、リダイレクトへ伝播します。`curl`、`wget`、PowerShell HTTP、SSH 系、SFTP inline `put`、`nc`、`openssl s_client`、パイプ、stdin upload sink を認識します。出力を解決できない機密処理は後続アップロードを保守的に汚染します。上書き、同一パス再梱包、不明スクリプトの変更、hash redirect は信頼状態を失効させます。リンク派生物は追跡しても TOCTOU 防止のため例外にしません。同一計画の独立した認証情報読み取りや非信頼流出は例外全体を取り消します。PATH/動的ローダー、alias/function、変数 SSH オプション、間接 shell/PowerShell/cmd 実行、SSH 設定を変更するコマンド置換も例外を取り消し、読み取り専用設定とバックアップは影響を受けません。
- `prepare_secure_ssh` の設定と自動生成鍵は既定で 24 時間後に失効し、`VECTORMIND_PREPARED_SSH_TTL_SECONDS` で変更できます。容量超過やプロセス終了時に MCP 作成の一時ディレクトリを削除し、再利用したユーザー秘密鍵は削除しません。設定パスは realpath containment を使い、ホスト絶対パスは返せますが秘密鍵内容はモデルへ返しません。
- `preflight_operation_scope` は追加鍵や署名 token なしで `safe_to_proceed` と blocker を直接返します。MCP は Codex などの端末権限を制御せず、実際の OS コマンド権限はホスト側の責任です。
- モデル可視パラメーターには blocker の承認バイパスがありません。標準 MCP 引数では現在のユーザー由来を証明できないため、モデル可視 token や「ユーザー確認済み」という文は信頼承認になりません。
- スキャン負荷は上限付きローカル CPU、ファイル読み取り、少量の出力 token だけで、AI の推論ラウンドを増やしません。finding がなければ compact 出力は詳細を展開せず、完全なフィールドは `format=json` で取得できます。

完全な能力と境界は [能力マトリクス（簡体字中国語）](docs/capability-matrix.md) を参照してください。

## 要件明確性のソフトガイダンス

VectorMind は MCP ハンドシェイク時に要件明確性ルールを AI へ提供します。AI は、現在のメッセージが作業を明示するか、未完了のユーザー要求を一意に指す場合にだけ行動し、対象要求には結果、対象、範囲、操作が必要です。完了済み要求は新しい作業を承認できません。承認が不足する場合はツール利用前にユーザーへ確認します。

これは advisory guidance です。VectorMind は現在のメッセージと要求に適用する判断境界を提供するだけで、モデル推論やホストランタイムを制御しません。要件が明確なら、AI は合理的な既定値で進められます。

## 巨大ファイルのルール

実装ファイルが巨大ファイル閾値に達した場合、責務を追加する前に機械的なモジュール分割を求めます。

- 実態のあるモジュール名と明確なディレクトリを使用します。
- 外部動作を維持し、分割後の境界を検証します。
- `*.generated.*`、`.parts`、`*.rs.parts`、`part1/part2`、`1_xxx/2_xxx` などの見せかけの分割を禁止します。
- 分割計画と結果を永続化し、後続セッションで継続できます。

## VectorMind が行わないこと

VectorMind はローカルプロジェクトメモリ、開発規約、品質証拠だけを提供し、次のことは行いません。

- Codex、Claude、その他クライアントの実行制御。
- モデルに代わる推論、設計、実装判断。
- クライアント権限、確認ダイアログ、実行ポリシーの変更。
- 曖昧な要件やクライアントツールへのランタイム強制遮断。要件ルールはソフトガイダンスです。
- checkpoint をファイル、データベース、モデル状態のロールバックとして扱うこと。

現在のユーザー指示と直接確認したリポジトリ事実は、常に過去のメモリより優先されます。

## 開発とリリース

```bash
npm ci
npm run build
npm run smoke
npm run verify
```

- `npm run smoke` はコア成果物を再ビルドし、security、checkpoint、operation、完全な MCP smoke を実行します。
- `npm run verify` はコアビルド、管理パネルテストと本番ビルド、全 smoke を実行します。
- `security-regression-cases.mjs` はプロンプトインジェクション、認証情報パス、通常アップロード、機密流出、DNS/SSH/SCP/SFTP、PowerShell、Node/Python、base64、tar/zip/7z、`dd`、派生ファイル stdin、環境変数チャネルを網羅します。
- セキュリティ回帰ではホスト承認 token、不正 token のバイパス、対象 allowlist、file advisory、複数ファイル grep、シンボリックリンク境界も検証します。
- `npm run verify` には上記のセキュリティ回帰、checkpoint/operation 回帰、管理パネルテスト、本番ビルドがすべて含まれます。
- `prepublishOnly` は完全な `verify` を強制します。
- リリース前に `npm pack --dry-run --ignore-scripts --json` でコア成果物、管理サービス、ビルド済みクライアントの同梱を確認できます。

リリース：

```bash
npm publish --access public
```

## ライセンスと権利

Copyright (c) 2025-2026 the VectorMind Licensor, publishing as yuanfeng-net. All rights reserved.

VectorMind は [VectorMind Source-Available License 1.0](LICENSE) を採用した source-available ソフトウェアであり、OSI 定義のオープンソースではありません。

- 個人・組織はインストール、実行、内部利用、非公開変更、必要なバックアップができます。従業員、関連会社、契約上拘束された委託先、ユーザーのために動作するクラウド CI/CD と基盤も利用できます。
- VectorMind で作成・処理したコード、文書、メモリ、レポートなどの独立成果物はユーザーに帰属し、VectorMind を利用しただけでは本ライセンスの制約を受けません。
- 公開ミラー、転載、再梱包、改名公開、変更版配布には Licensor の事前書面許可が必要です。
- 著作権、ライセンス、作者表示、公式 URL、npm 由来情報を削除できません。
- VectorMind または主要機能を第三者向け製品・サービスとして提供したり、コピーを独自・公式版と偽ったりできません。

唯一の公式リポジトリは <https://github.com/yuanfeng-net/VectorMind>、公式 npm パッケージは [`@coreyuan/vector-mind`](https://www.npmjs.com/package/@coreyuan/vector-mind) です。[LICENSE](LICENSE) の英語原文が優先されます。再配布、OEM、ホスティングサービスなどの権利は [LICENSING.md](LICENSING.md) から申請してください。外部コード貢献は権利関係を明確に保つため [CONTRIBUTING.md](CONTRIBUTING.md) に従います。

## 一言でいうと

VectorMind は AI に要件、意思決定、変更理由、プロジェクト境界を記憶させ、長期開発でのコンテキスト消失、意図しない変更、古いロジックへの回帰を減らします。

focused context recovery は関連性で明示的に絞り込まれ、完全復元にも出力上限があります。どちらもリポジトリ全体やライブランタイムを網羅すると主張しません。結果がないことは、事実が存在しなかった証明ではありません。ドメイン、送信元ホスト、ポート、デプロイ先、認証情報ファイル参照などの永続的な運用情報は復元できますが、秘密値は長期メモリ保存、シンボル抽出、文書インデックス化の前に再帰的に秘匿されます。要件作成時には高信頼度の重複も報告または拒否し、未完了インシデントが別ライフサイクルへ静かに分断されることを防ぎます。
