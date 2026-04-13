# BNI 商務交流媒合系統

BNI 長榮20週年商務交流活動 — 行動優先網頁應用程式。
與會者掃描 QR Code 後，可即時標記想認識的發言者與來賓。

## 功能概覽

| 功能 | 說明 |
|------|------|
| 登入 | 輸入姓名、桌號、選擇身份（長榮會員 / 來賓 / 親友） |
| Session 恢復 | 同樣姓名 + 桌號重新登入，自動恢復原有媒合記錄 |
| 目前發言者 | 即時顯示發言者資訊，每 5 秒自動更新 |
| 我想認識他 / 我可以幫助他 | 一鍵切換，即時儲存，最多選 3 位 |
| 換人彈窗 | 已選滿 3 位時，跳出彈窗讓使用者直接取捨，不需切換頁面 |
| 所有來賓 | 瀏覽全部參與者，含商務需求說明 |
| 大螢幕顯示 | 全螢幕顯示目前發言者，自動同步 |
| 管理員後台 | 上傳名單、設定發言者、清除使用者 / 參與者、匯出報表 |

## 技術棧

- **Backend**：Node.js + Express
- **Database**：[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)（原生 SQLite，WAL 模式，每次寫入即時存檔）
- **Frontend**：Vanilla JS + TailwindCSS CDN

## 系統需求

- Node.js 18 以上

## 安裝

```bash
npm install
```

## 啟動

```bash
# 正式環境
npm start

# 開發模式（自動重啟）
npm run dev
```

預設啟動於 `http://localhost:3000`

## 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `PORT` | `3000` | 伺服器監聽 port |
| `ADMIN_PASSWORD` | `bni2024` | 管理員後台密碼 |
| `DB_DIR` | `./database` | 資料庫目錄路徑（部署時指向 Persistent Volume） |

建議在正式環境建立 `.env` 檔案（已被 `.gitignore` 排除）：

```
PORT=3000
ADMIN_PASSWORD=你的強密碼
DB_DIR=/data
```

## 專案結構

```
├── server/
│   └── server.js          # Express 後端、所有 API
├── public/
│   ├── index.html         # 用戶端 SPA
│   ├── app.js             # 前端邏輯
│   ├── admin.html         # 管理員後台
│   └── display.html       # 大螢幕發言者顯示頁
├── database/
│   └── event.db           # SQLite 資料庫（首次啟動自動建立）
├── load-test.js            # k6 負載測試腳本（模擬 100 人併發）
├── sample-participants.csv # 範例名單（15 筆）
└── package.json
```

## 管理員操作

1. 前往 `http://localhost:3000/admin`
2. 輸入密碼（預設：`bni2024`）
3. 上傳 CSV 名單（格式見下方）
4. 活動中逐一設定「目前發言者」
5. 活動結束後下載 CSV 媒合報表

## 大螢幕顯示

前往 `http://你的網域/display`，按 **F** 鍵進入全螢幕。

管理員在後台切換發言者後，大螢幕 **3 秒內自動更新**，顯示姓名、專業、桌號與需求，無需人工操作投影機。

## CSV 匯入格式

```csv
name,industry,table,needs
王建宏,室內設計,6,希望認識建設公司與建材供應商
李雅慧,人力資源顧問,3,
```

- 第一列為標題列（必要）
- `needs` 欄位為**選填**
- 支援 UTF-8 及 UTF-8 with BOM（可直接用 Excel 儲存）

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/login` | 用戶登入；同姓名 + 桌號自動恢復舊 userId |
| GET | `/api/participants` | 取得所有參與者 |
| GET | `/api/current-speaker` | 取得目前發言者 |
| GET | `/api/connections?userId=X` | 取得用戶的媒合記錄 |
| POST | `/api/connect` | 新增媒合 |
| DELETE | `/api/connect` | 刪除媒合 |
| GET | `/api/admin/stats` | 統計數據（需驗證）|
| POST | `/api/admin/upload` | 匯入 CSV（需驗證）|
| POST | `/api/admin/set-speaker` | 設定發言者（需驗證）|
| DELETE | `/api/admin/participant/:id` | 刪除單一參與者（需驗證）|
| DELETE | `/api/admin/participants` | 清除所有參與者與媒合記錄（需驗證）|
| DELETE | `/api/admin/users` | 清除所有使用者與媒合記錄（需驗證）|
| GET | `/api/admin/export` | 匯出 CSV 報表（需驗證）|

## 負載測試

使用 [k6](https://k6.io/) 模擬 100 位使用者同時連線：

```bash
# 安裝 k6
brew install k6

# 測試本機
k6 run load-test.js

# 測試雲端環境
k6 run --env BASE_URL=https://你的網域 load-test.js
```

## 部署（Zeabur）

### 步驟一：建立專案與服務

1. 登入 [Zeabur](https://zeabur.com)，點擊 **New Project**
2. 選擇 **Deploy from GitHub**，連接你的 repository
3. Zeabur 會自動偵測 Node.js 並部署

### 步驟二：掛載 Persistent Volume（關鍵）

1. 進入服務頁面，點擊上方 **Volumes** 分頁
2. 點擊 **Add Volume**
3. 設定如下：
   - **Mount Path**：`/data`
4. 儲存後服務會自動重啟

> 第一次掛載時 `/data` 目錄會是空的，資料庫會在首次啟動時自動建立，無需手動處理。

### 步驟三：設定環境變數

1. 點擊 **Variables** 分頁
2. 新增以下變數：

| 變數 | 值 |
|------|----|
| `ADMIN_PASSWORD` | 你的強密碼 |
| `DB_DIR` | `/data` |

3. 儲存後服務會自動重啟

### 步驟四：確認部署成功

- 開啟 Zeabur 提供的網域，確認首頁可以正常載入
- 前往 `/admin` 輸入密碼，確認後台可以登入
- 重啟服務後，確認之前上傳的資料仍存在（驗證 Persistent Volume 生效）

## License

MIT
