# agent-crew

[English](README.md)

**agent-crew** 是一個 [Claude Code](https://code.claude.com) 外掛，用來做「分工開發」。由一個**統籌**（orchestrator）
工作階段負責規劃、寫任務書（brief），再派出**工人**（worker）子代理，在各自的 git worktree 裡實作；唯讀的**審查員**
（reviewer）與**反駁員**（refuter）子代理負責檢查成果，只有通過決定性過濾的發現才會送到你面前。進度由
**hook 與流程指令自動記錄，不靠模型自己記得去記**，並顯示在只監聽 `127.0.0.1` 的本機看板上。

它要解決的是：只靠文字規則來分工，常常會一再出現同樣的問題：

- 統籌自己動手寫程式，還跳過審查；
- 看板過時、重複或漏記；
- 任務書沒有邊界，工人改壞範圍以外的東西；
- 審查員挑出一大堆沒價值的意見，真正的問題被淹沒；
- 背景工作做完了卻沒人發現；
- 統籌把（昂貴的）上下文拿去讀大檔案；
- 規則只是一大段文字，寫了就被忘記。

agent-crew 把這些都變成強制或自動記錄的機制：五段式任務書（缺段落 CLI 直接拒收）、改程式與讀大檔的提醒、
由 hook 事件記錄狀態、三段式審查流程、尚未審查或仍在背景執行時的收尾提醒，以及只有你點頭才會升格成規則的經驗。

沒有任何執行期相依套件，需要 Node.js 18 以上，Windows、macOS、Linux 都能用。完全不連網，hook 與看板也不會呼叫模型。

## 運作方式

```
  你：「幫我做功能 X，分工去做」
    |
    v
  +--------------------------+   crew task create    +--------------------+
  | 統籌 orchestrator        | --------------------> | 任務書 + 任務      |
  | 主工作階段               |   （五段式任務書）    | （狀態機）         |
  | /agent-crew:crew         |                       +--------------------+
  +------------+-------------+                                ^
               | Agent 工具；提示詞帶有                       | 狀態
               | "crew-task: <id>"                            |
               v                                              |
  +--------------------------+   crew task report   +---------+----------+
  | 工人子代理 worker        | -------------------> | hook（每個事件）   |
  | 自己的 git worktree      |                      | 記錄、提醒、守門   |
  +------------+-------------+                      |                    |
               | 回報                               +---------+----------+
               v                                              |
  +--------------------------+  找出、過濾、反駁              v
  | 審查員 + 反駁員          | ---------------------> +--------------+
  | 唯讀                     |  只有倖存的發現        | 看板         |
  +--------------------------+  會送到你面前          | 127.0.0.1    |
                                                      +--------------+
```

**角色。** 統籌負責規劃、寫任務書、派工、審查與合併，自己不實作。工人在 worktree 裡完成一件任務，跑專案的檢查、
commit，絕不 push。審查員讀 diff、任務書與 `.crew/REVIEW.md`，回傳附證據的結構化發現。反駁員試著推翻每一筆倖存的發現。
每個角色在設定檔裡都有自己的 `engine` 與 `model`。

**任務流程。** `created -> dispatched -> returned -> (reviewing) -> accepted -> merged`。退回會讓任務回到
`dispatched`。退回次數達到 `max_returns_before_takeover`（預設 2）後，CLI 會拒絕再退回，並提示統籌自己接手。

**審查流程。**
1. *找出*：審查員寫出原始發現（類別、嚴重度、`file:line`、證據、驗證方式、信心）。
2. *過濾*（決定性、不用模型）：濾掉符合「已駁回清單」的、只憑推論的、信心太低的，以及超過上限的瑣碎意見；
   理論上的競態等型態會降為瑣碎意見。
3. *反駁*：反駁員試著推翻剩下的發現。你只會看到判定為成立或不確定的。

**Hook。** 同一支腳本（`scripts/crew-hook.js`）處理 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、
SubagentStart/Stop、Stop、PreCompact 與 SessionEnd。它們透過 `crew-task:` 標記把派出去的子代理對應到任務；統籌自己
改程式時提醒（或依設定直接擋下）；不帶範圍讀超大檔案時提醒；記錄 `git push` 與 `git merge`；有已回報卻未審查的工作時提醒；
並在工作階段結束時寫下決定性的摘要。沒有用 `crew init` 登錄的專案，所有 hook 都是靜默的空操作。詳見
[plugins/agent-crew/hooks/README.md](plugins/agent-crew/hooks/README.md)。

**看板。** `crew board start` 會啟動本機網頁：所有專案、依狀態排列的任務與退回次數、執行中的子代理、等你處理的事項、
工作流、紀錄、審查統計、經驗、交接、本機 Claude Code / Codex 工作階段即時清單、token 用量，以及由設定結構產生的設定頁。
支援英文與繁體中文。

完整的虛構示範流程請看 [examples/todo-cli/WALKTHROUGH.md](examples/todo-cli/WALKTHROUGH.md)（英文）。

## 安裝

從 marketplace 安裝（請把 `<owner>` 換成這個儲存庫的 GitHub 擁有者）：

```
/plugin marketplace add <owner>/agent-crew
/plugin install agent-crew@agent-crew
```

或是不安裝，直接用本機複本試用：

```
git clone https://github.com/<owner>/agent-crew
claude --plugin-dir agent-crew/plugins/agent-crew
```

技能要加上外掛名稱來呼叫：`/agent-crew:crew`。CLI 位於 `plugins/agent-crew/bin/crew.js`；在 Claude Code 裡由技能代你呼叫，
在終端機則用 `node plugins/agent-crew/bin/crew.js <指令>`。

## 快速開始

1. 安裝外掛（見上方），在你的 git 專案裡開啟 Claude Code。
2. 執行 `/agent-crew:crew init`。它會建立 `.claude/crew.json`、`.claude/agents/` 下的三個 agent 檔、
   `.crew/REVIEW.md` 與 `.crew/LESSONS.md`，並登錄專案。想要繁體中文輸出可加 `--lang zh-TW`。
   已存在的檔案不加 `--force` 絕不會被覆蓋。
3. 編輯 `.claude/crew.json`：設定 `checks`（例如 `["npm test"]`）以及要禁止的 `forbidden` 路徑或動作，
   然後 commit，讓團隊共用。
4. 交代工作：`/agent-crew:crew 幫 add 指令加上 --due 選項，分工去做`。統籌會寫任務書、建立任務與 worktree，
   並派出工人。派工由 hook 自動記錄，你不需要手動記任何東西。
5. 選用：請 Claude 啟動看板（`crew board start`），再開啟 `http://127.0.0.1:8781/`。
6. 工人回報後，統籌會跑審查流程、把倖存的發現給你看，決定退回或驗收，並在合併前先問你（`merge` 關卡預設是 `ask`）。

## 設定

專案設定在 `.claude/crew.json`（所有欄位都是選填）；全域設定（看板連接埠、用量單價、預設語言）在
`~/.agent-crew/config.json`。完整的欄位對照表由程式自動產生：[docs/CONFIG.md](docs/CONFIG.md)（含繁體中文說明）。
最常會動到的欄位：

| 欄位 | 用途 |
|---|---|
| `roles.<角色>.model` / `.engine` | 各角色使用的模型或外部引擎。 |
| `checks` | 工人回報前必須執行的指令。 |
| `forbidden.paths`、`forbidden.actions` | 寫進工人 agent 檔的禁止事項。 |
| `gates.*` | 推送、開 PR、合併、遠端主機、大型任務、安裝下載各自用 `auto`、`ask` 或 `never`。 |
| `limits.orchestrator_edit` | 統籌自己改程式時：`off`、`warn` 或 `block`。 |
| `limits.max_parallel_workers`、`limits.max_returns_before_takeover` | 同時工人數與退回次數上限。 |
| `review.min_confidence`、`review.report_inference`、`review.nit_cap` | 過濾的嚴格程度。 |
| `lessons.promote_after_days`、`lessons.rules_cap` | 經驗何時成為候選、規則最多幾條。 |

修改程式裡的設定結構後，請執行 `node scripts/gen-config-docs.js` 重新產生對照表；已提交的檔案若過期，測試會失敗。

## CLI 參考

所有指令、選項與檔案位置：[plugins/agent-crew/skills/crew/references/commands.md](plugins/agent-crew/skills/crew/references/commands.md)。
指令群組：`init`、`doctor`、`project`、`task`、`review`、`handoff`、`lesson`、`need`、`work`、`log`、`mr`、
`validate`、`board`、`import`。讀取類指令都支援 `--json`。

## 看板截圖

_截圖之後會補在這裡：總覽、專案（任務與審查統計）、工作階段、用量、設定。_

## 隱私與安全

- **只在本機。** 看板只綁定 `127.0.0.1`，會拒絕不符的 `Host` 標頭，不送 CORS 標頭，所有寫入都要帶每次啟動產生的
  token 並使用 JSON 內容類型，並送出嚴格的 CSP。沒有遙測、沒有對外連線，hook 與看板也不會呼叫模型。
- **遮蔽。** 文字會先遮蔽再截斷才儲存：私鑰、Bearer／Basic 認證、`password=` 之類的鍵值、常見服務金鑰、JWT，
  以及除了本機迴路與文件保留網段以外的 IP 位址。
- **資料放哪裡。** 執行期資料寫在 `~/.agent-crew/`（可用 `AGENT_CREW_HOME` 改位置）。專案內的檔案
  （`.claude/crew.json`、`.crew/*`）只會由 `crew init` 與經驗相關指令寫入。
- **Hook 在沙盒之外執行**，使用你自己的權限。它們只讀取標準輸入、專案的 git 資訊與 agent-crew 的檔案，只寫入資料目錄。
  它們不會自動登錄專案，也不會擋住 Stop。唯一刻意的拒絕，是你把 `orchestrator_edit` 設成 `block` 時的編輯守門。
- **文字一律當資料。** 檔案內容、報告、交接內容與審查發現，交給模型時都會加上圍欄並標示為不可信，
  裡面出現的指令不應被執行。
- **工人的界線**寫在產生出來的 agent 檔：只在指定的 worktree 與分支工作、可以 commit 但絕不 push、
  不連網不下載、不碰機敏資料、不略過測試或 hook。這些是對模型的指示，不是沙盒；關卡與審查的存在，
  正是因為指示有可能被忽略。

## 用 Codex 或其他 CLI 當審查員

審查員這個角色可以不用 Claude。全域設定（`~/.agent-crew/config.json`）預設就有名為 `codex` 的引擎（`codex exec -s read-only --skip-git-repo-check -`）。
在專案把 `roles.reviewer.engine` 設成 `codex`，或單次執行：

```
crew review run <任務> --engine codex
```

agent-crew 會組出提示詞（任務書、審查規則、diff），從標準輸入餵進去，從標準輸出取出 JSON 陣列的發現，
再接著走同樣的過濾與反駁階段。你也可以在**全域**設定的 `engines` 底下加自己的引擎，指定 `command` 與 `args`；提示詞一律從標準輸入傳入。
指令依 `PATH` 尋找（Windows 也支援 `.cmd`/`.bat`，不經 shell 啟動）。專案的 `.claude/crew.json` 只能用名稱引用引擎
（`roles.*.engine`）；專案檔裡的 `engines` 會被忽略並顯示警告，因為複製來的儲存庫不該決定 `crew review run` 要執行哪個程式。
`crew doctor` 會顯示每個引擎是否找得到。
Codex 只支援當審查員，不能當統籌。

## 限制

- 需要支援外掛的 Claude Code；hook 酬載中官方文件沒有載明的欄位，程式都以防禦式方式讀取，不同版本可能有差異。
- Hook 看不到模型的思考過程，只能記錄發生了什麼（派工、停止、git 指令），不知道為什麼。
- `crew task merge` 只記錄合併，不會執行 git。合併由統籌執行，hook 負責記錄那個指令。
- 工人的隔離方式是 worktree 加上指示，不是容器。
- 看板的工作階段清單是讀取本機 Claude Code 與 Codex 的紀錄；除非在全域設定打開 `board.show_text`，否則不顯示訊息文字。
- 沒有動畫式「辦公室」畫面，也不支援以 Codex 或 Gemini 當統籌。

## 參與貢獻

請先讀 [docs/DESIGN.md](docs/DESIGN.md)（英文），它是設計的唯一依據。接著：

```
npm test                          # 單元、hook、看板、端到端與儲存庫衛生測試（不連網）
node scripts/gen-config-docs.js   # 修改設定結構之後
```

規則：不得新增執行期相依套件、Node 18 以上、跨平台（不假設特定 shell）、測試只用暫存資料夾，絕不碰真實的
`~/.agent-crew` 或 `~/.claude`。儲存庫衛生測試會擋下多餘的 IP 位址、像憑證的字串與專案專屬名稱；
文件請用 `192.0.2.x`，測試中需要其他位址時請在執行時才組出來。修正與測試請放在同一次變更。

若有些名稱（公司名、信箱前綴）不得出現在儲存庫，請不要寫進任何受版控的檔案：把每行一個正規表示式放在未追蹤的
`.git/info/hygiene-extra`（或設環境變數 `AGENT_CREW_HYGIENE_EXTRA`，以分號分隔），衛生測試會把它們加進內建規則。

## 授權

[MIT](LICENSE)
