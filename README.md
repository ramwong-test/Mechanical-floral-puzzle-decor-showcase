# 機械花藝拼裝台 · Mechanical Floral Puzzle

互動式 3D 拼裝網頁:選花盆 → 在插槽插入莖(A 類頭接花 / B 類頭接連接器)→ 組出機械花束。

**線上版**(GitHub Pages)— 直接開啟 index.html。
雙開本機檔案(file://)不支援:瀏覽器的 CORS 限制,請用 GitHub Pages 或任何靜態伺服器。

## 新增零件

把 `.glb` 放進 `models/` 對應資料夾(Pot / Stem/A / Stem/B / Connector / End object),
slot 標記直接讀自 GLB 內建節點(`Stem_slotN`、`E_slot`/`C_slot`、`Stem_slot`),然後:

```
node catalog-gen.mjs
```

重新產生 `catalog.js` 後重新整理頁面即可。

## 檔案

```
index.html        主頁面
app.bundle.js     程式主體(three.js + 應用,已打包)
styles.css        樣式
catalog.js        零件清單(catalog-gen.mjs 自動產生)
catalog-gen.mjs   清單產生器(node catalog-gen.mjs)
models/           原始 .glb 模型
fonts/            本地字型(Fraunces / Karla)
```
