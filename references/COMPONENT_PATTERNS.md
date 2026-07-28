# Component Patterns Reference

> 詳細的元件邊界、CSS 規範、Hydration 策略、Smart Slot 系統及資料隔離模式。
> 主規則見 `../01-CLAUDE.md` Section 9。

---

## 1. Astro + Svelte 邊界規則

### 邏輯分配矩陣

| 邏輯類型 | 位置 | 原因 |
|---|---|---|
| DB 查詢 | Astro frontscript (`---` 區塊) | Server-only，可 async |
| 使用者互動（click, input, drag） | Svelte components | 需要 JS runtime |
| 即時狀態（counters, toggles） | Svelte ($state, $derived) | Reactivity |
| 靜態數據渲染（store.name, SEO 文本） | Astro template | 無 JS overhead，SEO 最佳 |
| 查詢結果傳給 Svelte | Astro frontscript -> props | `<Component {stores} />` |
| API 路由 | Astro API routes / Hono routes | 取決於需求 |

### 關鍵原則

- Astro 負責**資料獲取**和**靜態渲染**：所有 DB 查詢在 `---` 區塊完成
- Svelte 負責**互動邏輯**：事件處理、狀態管理、UI 動畫
- [NEVER] 在 Svelte 中做 DB 查詢
- [NEVER] 在 Astro template 中做複雜運算（移到 frontscript）
- Props 從 Astro 向 Svelte **單向流動**

### 錯誤模式

```typescript
// 錯誤：Svelte 中做 DB 查詢
<script>
  // Svelte component
  const stores = await db.select().from(stores); // 不可能在 client
</script>

// 正確：Astro frontscript 查詢，props 傳入
---
import StoreList from './StoreList.svelte';
const stores = await getStores(tenantId);
---
<StoreList {stores} />
```

---

## 2. Hydration 策略

### 策略選擇

| 場景 | 指令 | 原因 |
|---|---|---|
| Admin 元件（一律互動） | `client:load` | 立即需要互動 |
| 首頁區塊（下方折疊） | `client:visible` | 延遲載入，節省資源 |
| SEO 關鍵內容 | 不 hydrate | 純 Astro template，零 JS |
| 表單元件 | `client:load` | 需要即時驗證 |
| 地圖元件 | `client:visible` | 通常在折疊以下 |

### 最佳實踐

- 最小化 hydrate 元件數量
- SEO 關鍵文本永遠不要放在需要 hydration 的元件中
- 傳遞序列化安全的 props（避免函數、Date 物件等）

---

## 3. CSS 規範與 BEM 命名

### Astro + Svelte CSS 交互問題

**核心問題**：Astro 處理 Svelte 元件時，Svelte 的 scoped `<style>` 可能被丟棄或行為不一致。

| 規則 | 指令 | 原因 |
|---|---|---|
| Admin 元件必須 import CSS 檔 | [MUST] | Astro 會丟棄 Svelte scoped style |
| 用 BEM 命名作為 scoping | [ALWAYS] | 替代 Svelte scoped style |
| 公開元件可用 Astro `<style>` | [ALWAYS] | Astro 處理自己的 style |
| 禁止依賴 Svelte scoped `<style>` | [NEVER] | 在 Astro 環境中不可靠 |

### BEM 命名慣例

```
.block-name__element--modifier
```

```css
/* Block */
.admin-panel { }

/* Element */
.admin-panel__header { }
.admin-panel__content { }
.admin-panel__footer { }

/* Modifier */
.admin-panel--compact { }
.admin-panel__header--sticky { }
```

### CSS 檔案組織

```
src/
  components/
    admin/
      AdminPanel.svelte
      admin-panel.css     # 對應的 CSS 檔
    public/
      StoreCard.astro     # 可用 Astro <style>
```

### 正確模式

```typescript
// AdminPanel.svelte
import './admin-panel.css';

// 使用 BEM class names
<div class="admin-panel">
  <div class="admin-panel__header">...</div>
  <div class="admin-panel__content">...</div>
</div>
```

### 錯誤模式

```html
<!-- 錯誤：依賴 Svelte scoped style -->
<style scoped>
  .header { color: red; } /* Astro 可能丟棄 */
</style>
```

---

## 4. Smart Slot 系統

### 概念

Smart Slot 是一種動態內容注入模式，允許 Astro 佈局定義具名 slot，由頁面或元件填充。用於實現可擴展的頁面結構。

### 基本用法

```astro
---
// Layout.astro
---
<div class="page-layout">
  <header>
    <slot name="header" />
  </header>
  <main>
    <slot /> <!-- 預設 slot -->
  </main>
  <footer>
    <slot name="footer" />
  </footer>
</div>
```

```astro
---
// Page.astro
import Layout from './Layout.astro';
---
<Layout>
  <Fragment slot="header">
    <h1>Page Title</h1>
  </Fragment>
  
  <!-- 預設 slot 內容 -->
  <p>Main content here</p>
  
  <Fragment slot="footer">
    <p>Custom footer</p>
  </Fragment>
</Layout>
```

### 條件 Slot

```astro
---
// 檢查 slot 是否有內容
const hasSidebar = Astro.slots.has('sidebar');
---
<div class={`layout ${hasSidebar ? 'with-sidebar' : 'full-width'}`}>
  <main><slot /></main>
  {hasSidebar && <aside><slot name="sidebar" /></aside>}
</div>
```

---

## 5. 資料隔離詳細模式

### 多租戶隔離

所有查詢必須包含 tenant 過濾器，防止跨租戶數據洩漏。

```typescript
// 正確：含 tenant 過濾器
const items = await ddb.select().from(items).where(
  and(eq(items.tenantId, tenantId), eq(items.active, true))
);

// 錯誤：無 tenant 隔離
const items = await ddb.select().from(items).where(eq(items.active, true));
```

### 軟刪除模式

```typescript
// 核心實體 schema
export const stores = sqliteTable('stores', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  name: text('name').notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
});

// 讀操作必須過濾已刪除
const activeStores = await ddb.select()
  .from(stores)
  .where(and(
    eq(stores.tenantId, tenantId),
    isNull(stores.deletedAt)
  ));

// 刪除操作 = 更新 deletedAt
await ddb.update(stores)
  .set({ deletedAt: new Date() })
  .where(eq(stores.id, storeId));
```

### Edge D1 事務模式

```typescript
// 正確：事務前獲取所有數據
const existingData = await ddb.select().from(table)
  .where(eq(table.id, id));

// 事務中只做寫操作
await ddb.batch([
  ddb.update(table).set({ status: 'processed' }).where(eq(table.id, id)),
  ddb.insert(auditLog).values({ action: 'process', entityId: id }),
]);
```

### 前綴 ID 模式

```typescript
import { nanoid } from 'nanoid';

// 暴露的記錄使用前綴 ID
const storeId = `str_${nanoid()}`;
const itemId = `itm_${nanoid()}`;
const orderId = `ord_${nanoid()}`;
const categoryId = `cat_${nanoid()}`;

// 內部關聯可用原始 ID
```

### JSON metadata 模式

```typescript
// 正確：行業特定數據存在 JSON 欄位
export const stores = sqliteTable('stores', {
  id: text('id').primaryKey(),
  metadata: text('metadata', { mode: 'json' }).$type<StoreMetadata>(),
  options: text('options', { mode: 'json' }).$type<StoreOptions>(),
});

// 錯誤：添加行業特定欄位到主 schema
export const stores = sqliteTable('stores', {
  id: text('id').primaryKey(),
  restaurantType: text('restaurant_type'), // 行業特定
  cuisineType: text('cuisine_type'),       // 行業特定
});
```

---

## 6. UI 設計反模式（詳細）

### 避免 AI Slop 模式

| 反模式 | 問題 | 原因 |
|---|---|---|
| 大圖標 + 圓角背景 above 每個標題 | 裝飾性無意義 | AI 常過度使用，造成視覺噪音 |
| 千篇一律的卡片網格 | 相同大小/結構 | 缺乏層次感，像模板工廠 |
| Hero metrics 布局（大數字 + 小標籤） | 停留在表面 | 無敘事深度，適合 dashboard 不適合內容頁 |
| Gradient text "for visual impact" | 不必要噪聲 | 降低可讀性，無實際價值 |
| Glassmorphism（模糊背景 + 透明度） | 模糊而非聚焦 | 效能問題，可讀性差 |

### 偏好設計模式

| 模式 | 描述 | 技術實現 |
|---|---|---|
| 大膽留白 | 呼吸空間 > 填充空間 | CSS Grid, padding/margin |
| 非對稱構圖 | 打破模板感 | Flexbox, 負邊距 |
| 漸進式揭露 | hover 顯示次要操作 | CSS `:hover`, `transition` |
| 流暢載入動畫 | 提供視覺回饋 | `@keyframes`, CSS animation |
| 直接排版 | 字重/大小對比代替裝飾 | `font-weight`, `font-size` contrast |

### 色彩規範

- 使用 OKLCH 色彩空間確保 WCAG AA 合規
- Tailwind CSS 為主要工具
- 對比度檢查：所有文字/背景組合必須通過 AA 標準

---

## 7. 資料驗證模式

### 元件級驗證

```typescript
// 正確：驗證 -> 渲染 或 null
let data = $state<DataType | null>(null);

async function loadData() {
  const result = await fetchData();
  if (!result.isValid) {
    data = null;
    return;
  }
  data = result;
}

// 模板
{#if data}
  <Content {data} />
{/if}
```

### 異步操作三態

```typescript
let data = $state<Data | null>(null);
let isLoading = $state(false);
let error = $state<string | null>(null);

async function loadData() {
  isLoading = true;
  error = null;
  try {
    data = await fetchData();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    isLoading = false;
  }
}
```

### Svelte $effect 防禦

```typescript
// 正確：處理 undefined props
$effect(() => {
  if (props?.data) {
    processData(props.data);
  }
});

// 錯誤：未處理 undefined
$effect(() => {
  processData(props.data); // props 可能不存在
});
```
