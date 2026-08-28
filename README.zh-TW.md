[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | **繁體中文**

# VectorMind MCP

VectorMind 是面向 AI 程式設計助手的本機專案記憶 MCP。它會把需求、決策、修改原因、專案約定和檔案狀態保存在專案目錄中，協助長期開發減少上下文遺失、跨專案混線，以及退回舊邏輯的問題。

目前版本：`1.1.6`

## 核心能力

- **恢復專案上下文**：依目前目標找回專案摘要、需求、決策、約定和相關記憶。
- **引導需求明確性**：透過 MCP server instructions 提醒 AI 只在取得完整授權後行動，授權不足時先詢問使用者。
- **限制修改範圍**：編輯前核對需求項目、計畫檔案和巨量檔案治理要求。
- **記錄修改意圖**：將變更檔案、實作原因、驗證結果和剩餘缺口歸檔到對應需求。
- **管理需求生命週期**：支援串列工作、明確的平行工作、恢復已完成工作及更新驗證結果。
- **更新權威決策**：新決策可以 supersede 舊需求或舊記憶，避免後續工作階段依過時規則實作。
- **隔離多個專案**：記憶、pending buffer、索引和資料庫都依 `project_root` 隔離。
- **安全讀取專案檔案**：使用 canonical realpath 驗證，拒絕透過符號連結或 junction 越過專案邊界。
- **掃描不受信任的內容與操作**：檔案、記憶、`grep` 和符號查詢結果會附帶 `security_scan`；只有高可信度的敏感資料外傳會在具體操作預檢中阻擋，一般文件、文章、測試樣本和明確的一般上傳仍維持 advisory。
- **準備安全的 SSH 部署**：`prepare_secure_ssh` 在宿主機內讀取伺服器設定，只回傳目標中繼資料與 SSH 設定路徑，不回顯密碼或私鑰；優先重用宿主 SSH key，沒有可用 key 時建立暫時 Ed25519 key，強制停用密碼驗證，並要求先安裝公鑰。
- **保存長期工作階段檢查點**：建立有界、版本化 checkpoint，並以唯讀方式恢復或比較上下文。
- **診斷記憶品質**：檢查衝突、重複、過大 checkpoint、過期索引和孤立記憶。
- **控制上下文大小**：預設使用精簡工具集和緊湊輸出，大型結果仍保留關鍵 ID 與完成狀態。

完整能力表請見 [能力矩陣（簡體中文）](docs/capability-matrix.md)。

## 快速安裝

建議直接把專案網址傳給 AI 程式設計助手，讓它自動完成安裝與設定：

```text
請安裝並設定 VectorMind MCP：
https://github.com/yuanfeng-net/VectorMind

請自動辨識我目前使用的 AI 程式設計用戶端，完成安裝、MCP 設定和可用性驗證。
除非缺少必要權限，否則不需要讓我手動執行指令。
```

通常只需要傳送 GitHub 網址並說明「幫我安裝」即可。AI 會依儲存庫說明辨識目前用戶端、更新對應 MCP 設定並驗證是否可用，使用者不需要記住安裝指令或手動編輯設定檔。

## 手動安裝與設定（選用）

手動設定需要 Node.js `20.19.0` 或更新版本。

直接執行 MCP：

```bash
npx -y @coreyuan/vector-mind
```

或全域安裝：

```bash
npm install -g @coreyuan/vector-mind
```

全域安裝後提供三個指令：

```text
vector-mind        # MCP stdio 服務
vector-mind-admin  # 正式環境管理面板
rtk                # RTK 相容入口
```

### 手動設定 Codex

在 `~/.codex/config.toml` 加入：

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
```

設定後重新啟動 Codex，並在新工作中使用。

### 手動設定 Claude Desktop

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

## 管理面板

安裝並設定 MCP 後，管理面板會隨 `vector-mind` MCP 程序在背景自動啟動，不必另外執行服務。直接開啟：

```text
http://127.0.0.1:16860
```

也可以手動啟動以進行疑難排解：

```bash
vector-mind-admin
```

預設位址為 [http://127.0.0.1:16860](http://127.0.0.1:16860)。預設只監聽 loopback，並為 loopback 要求建立目前頁面的工作階段，因此不需要手動輸入 token。

頁面載入和重新整理時，專案索引會以唯讀方式同步 Codex 桌面版 `$CODEX_HOME/.codex-global-state.json` 中的本機專案清單，並依 Codex 順序顯示。不存在的目錄會略過；手動加入和目錄掃描找到的專案不會被 Codex 同步刪除。

從原始碼執行：

```bash
npm ci
npm run build
npm run admin:start
```

開發模式使用 Vite middleware 和 HMR：

```bash
npm run admin:dev
```

可用環境變數：

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `VECTORMIND_ADMIN_HOST` | `127.0.0.1` | 管理服務監聽位址 |
| `VECTORMIND_ADMIN_PORT` | `16860` | 管理服務連接埠 |
| `VECTORMIND_ADMIN_TOKEN` | 無 | 非 loopback 監聽時必須明確設定 |
| `VECTORMIND_ADMIN_AUTO_START` | `true` | 設為 `false`、`0`、`no`、`off` 或 `disabled` 時關閉隨 MCP 自動啟動 |

監聽非 loopback 位址時，服務會在啟動階段強制檢查 `VECTORMIND_ADMIN_TOKEN`。token 不會透過 `/api/config` 回傳；瀏覽器輸入的 token 只保存在目前分頁的 `sessionStorage`。受保護 API 會同時驗證 token 和同源 `Origin`，缺少 `Origin` 也不能繞過驗證。

完整說明請見 [管理面板文件（簡體中文）](admin-panel/README.md)。

## 使用方式

使用者不需要記住或手動輸入任何 VectorMind 工具指令。像平常一樣以自然語言說明工作目標、限制和預期結果即可，AI 用戶端會在需要時自動恢復相關上下文、檢查修改範圍並記錄變更原因。

如果同一工作階段需要同時處理多個不相關工作，只需向 AI 明確說明哪些工作需要平行保留，以及各自的專案和目標；內部需求識別碼和工具呼叫由用戶端管理。

VectorMind 的品質訊號只是上下文證據，不替模型或使用者作決定。

### 安全掃描邊界與負荷

安全掃描用於辨識提示注入、憑證存取、主機探測和本機敏感資料外傳。它不會接管其他 MCP 工具，也不會主導 AI 的推理、設計或實作方向：

- 檔案、記憶、`grep`、語意搜尋和符號查詢回傳的掃描結果屬於 advisory 訊號，明確標示 `advisory_only`、`coverage` 和 `complete`。
- 只有 `preflight_operation_scope` 偵測到高可信度敏感憑證外傳時，才會對該具體操作回傳 blocker。透過 MCP 寫入的 decision、requirement、note 和 convention 沒有經宿主驗證的使用者來源，只能產生 warning，不能覆蓋目前使用者要求或把 `safe_to_proceed` 改為 false。一般讀取、查詢、程式碼產生和其他 MCP 功能不受影響。
- 部署說明、檔案清單、`--exclude`、遠端路徑及 `ssh/scp -i` identity file 不會被視為上傳內容；本機 `.env` 成為部署來源時預設阻擋。可信目標只接受由宿主啟動變數 `VECTORMIND_DEPLOYMENT_HOST` 登記的正規化 IPv4/IPv6 字面位址，或由 `prepare_secure_ssh` 明確產生、登記並通過雜湊驗證的 `-F` 設定。儲存庫內的 `server.txt` 不能單獨建立信任，無效環境值會 fail closed。只有 `.env` 或可完整追蹤的複製、改名、編碼、封存衍生物，全部透過可信系統 OpenSSH/SSH-style rsync 傳往該 IP 時才取得例外。連結衍生物、SSH 私鑰、雲端憑證、`server.txt` 和宿主環境變數永遠不會取得例外。
- 只有敏感 SSH 上傳且沒有已登記 `-F` 設定時才執行 `ssh -G`。驗證會帶入實際遠端使用者、連接埠和安全 `-o`，要求最終 `hostname` 等於目標 IP、採用公鑰和 `BatchMode`、啟用主機金鑰驗證，並停用密碼、keyboard-interactive、控制 socket 重用、Agent/stdio/連接埠轉送、跳板 proxy、`ProxyCommand`、`LocalCommand`、`KnownHostsCommand` 和空 known-host 檔案。一般 build/test/git 及使用已登記設定的部署不會啟動此子程序。
- 接受目前操作未修改之執行搜尋環境中的標準指令名稱，以及 `/usr/bin`、`/bin` 或 Windows System32 OpenSSH 明確路徑。裸指令名稱不宣稱完成檔案雜湊身分驗證。`./scp`、`/tmp/ssh`、偽裝指令碼、自訂 SSH/SCP/SFTP 或控制 socket、轉送選項、危險 `-o` 和自訂 rsync transport 不取得例外。標準 `rsync -e ssh`、`/usr/bin/ssh` 和安全的 `RSYNC_RSH=ssh` 維持相容。
- 資料流會依指令順序傳播到變數化 copy/move、符號與硬式連結、base64、tar/zip/7z、`dd`、敏感環境變數寫入、常見指令碼/PowerShell 寫檔與重新導向。可辨識 `curl`、`wget`、PowerShell HTTP、SSH 系列、SFTP inline `put`、`nc`、`openssl s_client`、管線和 stdin upload sink。無法解析輸出的敏感處理會保守污染後續上傳。覆寫、同路徑重新封裝、未知指令碼修改或 hash redirect 會讓可信狀態失效。連結衍生物即使可追蹤也不取得例外，以避免 TOCTOU。同一計畫中的獨立憑證讀取或不可信外傳會撤銷整個例外；PATH/動態載入器、alias/function、變數化 SSH 選項，以及會修改 SSH 設定的間接 shell/PowerShell/cmd 執行或指令替換也會撤銷例外。唯讀 SSH 設定與備份不受影響。
- `prepare_secure_ssh` 設定和自動產生的金鑰預設 24 小時過期，可用 `VECTORMIND_PREPARED_SSH_TTL_SECONDS` 調整。容量淘汰和程序結束會清理 MCP 建立的暫存目錄，重用的使用者私鑰永不刪除。設定路徑使用 realpath containment；可以回傳宿主絕對路徑，但不會將私鑰內容回傳模型。
- `preflight_operation_scope` 直接回傳 `safe_to_proceed` 和 blocker，不要求額外金鑰或簽章 token。MCP 不控制 Codex 或其他用戶端的終端權限；實際 OS 指令權限仍由宿主負責。
- 模型可見參數沒有安全 blocker 的授權繞過。標準 MCP 參數無法證明資料來自目前使用者，因此模型可見 token 或「使用者已確認」文字不能成為可信授權。
- 掃描只增加有界的本機 CPU、檔案讀取和少量輸出 token，不增加 AI 推理輪次。沒有 finding 時 compact 輸出不展開安全細節；完整欄位可透過 `format=json` 查看。

完整能力與邊界請見 [能力矩陣（簡體中文）](docs/capability-matrix.md)。

## 需求明確性軟引導

VectorMind 會在 MCP handshake 中向 AI 提供需求明確性規則。AI 只有在目前訊息明確要求工作，或明確指向唯一未完成的使用者要求，且所選要求定義結果、目標、範圍和操作時才應行動。已完成要求不能授權新工作；缺少完整授權時，AI 應在呼叫工具或行動前詢問使用者。

這項能力屬於 advisory guidance。VectorMind 只提供由 AI 結合目前訊息和使用者要求套用的判斷邊界，不接管模型推理或宿主執行環境。需求已明確時，AI 可採用合理預設繼續執行，不必重複確認。

## 巨量檔案規則

當實作檔案達到巨量門檻時，VectorMind 會要求先進行機械式模組拆分，再繼續增加職責：

- 使用真實模組名稱和清楚的目錄結構。
- 維持外部行為不變，並驗證拆分後的模組邊界。
- 禁止 `*.generated.*`、`.parts`、`*.rs.parts`、`part1/part2`、`1_xxx/2_xxx` 等假拆分或排序式命名。
- 拆分計畫和實際結果會持久化，後續工作階段可延續同一計畫。

## 不會做的事

VectorMind 只提供本機專案記憶、開發規範和品質證據，不會：

- 接管 Codex、Claude 或其他用戶端的執行控制。
- 取代模型完成推理、設計或實作決策。
- 修改用戶端權限、確認視窗或執行政策。
- 對模糊需求或用戶端工具實施執行階段強制阻擋；需求明確性規則是軟引導。
- 將 checkpoint 視為檔案、資料庫或模型狀態回復。

目前使用者指示和直接觀察到的儲存庫事實始終高於歷史記憶。

## 開發與發布

```bash
npm ci
npm run build
npm run smoke
npm run verify
```

- `npm run smoke` 會重建核心產物，再執行 security、checkpoint、operation 和完整 MCP smoke。
- `npm run verify` 會執行核心建置、管理面板測試與正式建置，以及全部 smoke。
- `security-regression-cases.mjs` 涵蓋提示注入、憑證路徑、一般上傳、敏感外傳，以及 DNS/SSH/SCP/SFTP、PowerShell、Node/Python、base64、tar/zip/7z、`dd`、衍生檔案 stdin 和環境變數通道。
- 安全回歸也驗證宿主授權 token、錯誤 token 繞過、目標主機 allowlist、檔案 advisory 語意、多檔 grep 涵蓋及符號連結邊界。
- `npm run verify` 已包含上述安全回歸、checkpoint/operation 回歸、管理面板測試和正式建置。
- `prepublishOnly` 強制執行完整 `verify`。
- 發布前可用 `npm pack --dry-run --ignore-scripts --json` 檢查核心產物、管理服務和預先建置用戶端是否包含在套件中。

發布：

```bash
npm publish --access public
```

## 授權與權利歸屬

Copyright (c) 2025-2026 the VectorMind Licensor, publishing as yuanfeng-net. All rights reserved.

VectorMind 採用 [VectorMind Source-Available License 1.0](LICENSE)，屬於原始碼可見軟體，不是 OSI 定義的開放原始碼軟體：

- 個人和組織可安裝、執行、內部使用、私下修改和製作必要備份；員工、關聯公司、受約束的承包商，以及代表使用者運作的雲端 CI/CD 和基礎設施也可使用。
- 使用者透過 VectorMind 建立或處理的程式碼、文件、記憶、報告和其他獨立產物歸使用者所有，不會僅因使用 VectorMind 而受本授權限制。
- 公開鏡像、轉載、重新封裝、改名發布或散布修改版，必須事先取得 Licensor 書面許可。
- 不得移除著作權、授權、作者歸屬、官方專案網址或 npm 來源資訊。
- 不得把 VectorMind 或其主要功能包裝成第三方產品或服務，也不得冒充原創或官方版本。

唯一官方儲存庫為 <https://github.com/yuanfeng-net/VectorMind>，唯一官方 npm 套件為 [`@coreyuan/vector-mind`](https://www.npmjs.com/package/@coreyuan/vector-mind)。以 [LICENSE](LICENSE) 英文正文為準；重新散布、OEM、託管服務或其他商業權利請依 [LICENSING.md](LICENSING.md) 申請。外部程式碼貢獻依 [CONTRIBUTING.md](CONTRIBUTING.md) 辦理，以維持清楚的權利鏈。

## 一句話

VectorMind 讓 AI 記住需求、決策、修改原因和專案邊界，在長期開發中減少上下文遺失、意外修改和退回舊邏輯。

聚焦上下文恢復會明確依相關性篩選，完整恢復也始終受輸出上限限制；兩種模式都不宣稱涵蓋整個儲存庫或即時執行狀態。因此沒有符合結果不代表某項事實從未存在。網域、來源主機、連接埠、部署目錄和憑證檔案參照等持久執行事實可被恢復，而秘密值會在寫入長期記憶、擷取符號和建立文件索引前遞迴遮罩。建立需求時也會報告或拒絕高可信度重疊，避免尚未結束的事件被靜默拆成新的生命週期。
