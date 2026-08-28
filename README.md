# All-in-One 文件隱私 Metadata 清理器

這個專案是一個純前端、可離線運作的**文件隱私 Metadata 清理工具**。它整合了圖片（EXIF）、PDF、與 Office 文件（docx, xlsx, pptx）的 Metadata 掃描與清除功能，讓使用者在單一 HTML 網頁中，就可以批次且安全地清除所有文件的隱私數據，而無需將檔案上傳至任何伺服器。

一般使用者請先閱讀：[白話易懂的詳細使用者說明](USER_GUIDE.md)。

## 🚀 專案特色

- **多合一整合**：支援圖片 (`.jpg`, `.jpeg`, `.png`, `.webp`)、`.pdf`、`.docx`、`.xlsx`、`.pptx` 等多種常見格式。
- **純前端執行**：所有解析與擦除邏輯均在瀏覽器本機內執行，確保資料絕不外流。
- **批次處理與對照**：支援多檔案拖放，並展示清除前後的詳細 Metadata 欄位對比。
- **離線可用**：提供「下載本工具離線版」功能，下載後可完全斷網雙擊點開使用。

---

## 📂 目錄結構

```
Docu_Prav/
├── shared/                         # 跨工具共用的模組與第三方資源
│   ├── vendor/                     # 第三方 Web 函式庫 (如 fflate.js, pdf-lib 等)
│   └── *.js                        # 各格式的 Metadata 解析與擦除核心邏輯
├── scripts/
│   └── bundle.py                   # 單檔打包工具 (將 src/ 內容編譯為 standalone index.html)
└── AllInOne_document-privacy-cleaner/
    ├── src/                        # 開發原始碼目錄
    │   ├── index.html              # 包含 placeholders 的開發版網頁
    │   ├── bundle.json             # 打包資源定義檔
    │   └── all-in-one-meta.js      # 整合層分流與 UI 互動邏輯
    ├── PRD.md                      # 產品需求文件
    ├── README.md                   # 專案說明文件 (本檔)
    ├── index.html                  # 最終產出的 Standalone 單一網頁檔 (由 bundle.py 編譯)
    └── bundle_manifest.json        # 打包資源雜湊明細
```

---

## 🛠️ 開發與編譯打包

本專案採用 **單一 HTML 打包架構**。在開發時，您僅需修改 `src/index.html` 與相關的 JS 檔案，完成後執行打包指令：

### 打包指令

請在專案根目錄下（即 `Docu_Prav` 的同級目錄或 `Docu_Prav` 目錄下），根據打包腳本執行：

```bash
# 進入 Docu_Prav 目錄
cd Docu_Prav

# 執行打包 (將 src 打包至上一層目錄)
python3 scripts/bundle.py AllInOne_document-privacy-cleaner/src AllInOne_document-privacy-cleaner
```

這會自動解析 `src/index.html` 中的 `<!--{{SHARED:模組名}}-->` 與 `<!--{{ASSET:資源名}}-->` 標記，將相關 CSS/JS 內嵌，並產出最終的 `AllInOne_document-privacy-cleaner/index.html` 與 `AllInOne_document-privacy-cleaner/bundle_manifest.json`。

---

## 🧪 測試驅動開發 (TDD) 與驗證

本專案在非沙箱環境下，提供兩種驗證測試機制：

### 1. 手動整合測試
- 打包完成後，直接在瀏覽器雙擊打開 `AllInOne_document-privacy-cleaner/index.html`。
- 準備包含以下特性的測試檔案：
  - 含有 GPS 的 `.jpg` 或 `.webp` 圖片。
  - 含有作者資訊的 `.pdf`。
  - 含有樞紐分析表快取的 `.xlsx`。
- 將檔案拖入網頁，確認能正確識別並展示風險，清除後對比表欄位皆變為已清除，且能正確下載。

### 2. 自動化測試 (Playwright E2E)
您可以安裝並執行本機 Playwright 測試腳本，自動模擬使用者上傳與清除流程，以達到 TDD 規格驗收：

```bash
# 安裝依賴 (如尚未安裝)
npm install -D playwright

# 執行驗收測試
npx playwright test
```
*(自動化測試代碼位於 test/ 相關目錄下)*
