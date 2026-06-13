# 潜空间银河 · UMAP 测谎仪 (Latent Galaxy · UMAP Lie Detector)

> 把大模型内部的**词向量**渲染成一片可飞行穿梭的 3D 星系，再叠一层"测谎滤镜"，
> 用真实数据当场证明——**UMAP 给你一张好看的地图，但这张地图的"距离"是假的：近邻是真的（局部诚实），可那些漂亮的簇间分离/全局布局是 UMAP 编的（全局撒谎）。**

信息技术前沿创新课程项目。方向：**可解释性 / 表征可视化的可信度审计**。一句话立意：**好看 ≠ 真实——UMAP 局部诚实、全局撒谎。**

---

## 这是什么 / 研究点（含真实数据自测结论）

- 大模型把每个词变成 768 维向量（"潜空间"），意思相近坐标相近。人看不了 768 维，要降到 3 维。
- **关键自测发现（GPT-2 真实数据，8000 词）**——原以为"UMAP 处处撒谎"，实测纠正为**双面性**：

  | 指标 | PCA | UMAP | 含义 |
  |---|---|---|---|
  | 局部可信度(保近邻) | 0.616 | **0.716** | UMAP **局部更诚实**（保住了你的真邻居） |
  | 全局保真(保距离) | **0.345** | 0.176 | UMAP **全局严重撒谎**（簇间距离/布局是假的） |

- 所以"测谎"= 给每个词算**全局失真**（`1 − 高维↔低维距离的 Spearman`），把被 UMAP 全局编造的词**烧红**；并用 **Shepard 图**（高维距离→低维距离散点）当铁证：UMAP 散成一团 = 全局距离没意义。
- 这个"局部真/全局假"的结论比"UMAP 就是骗子"更准确、更有研究味，是本项目的核心贡献。

详见 [`docs/概念入门.md`](docs/概念入门.md)（通俗入门 + 汇报备稿）、[`docs/热力可视化计划.md`](docs/热力可视化计划.md)（可视化技法）。
跑 `pipeline/diagnose_metrics.py` 可复现上面的自测数字。

---

## 快速开始

### 方式 A：零依赖看星系（推荐先跑这个）
前端是纯静态页 + 本地 vendored Three.js，**不连任何 CDN / API，断网可跑**。仓库自带合成样本 `web/data/galaxy.sample.json`，克隆即可演示。

```bash
# 任选一个静态服务器，根目录指向 web/
cd web
python -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000
```

操作：右上面板切 **PCA ⇄ UMAP**、切 **语义聚类 / 失真测谎**、点 **⚡一键测谎**、从**案例库**挑"最会骗人的聚类"聚焦。

### 方式 B：带"实时检验"后端
让"老师给任意输入 → 现场跑 → 插进星系"这条链路可用。

```bash
pip install -r server/requirements.txt   # mock 模式只需 flask
python server/app.py                      # 打开 http://127.0.0.1:5000
```
- 没装 ML 依赖也能跑：后端进 **mock 模式**，把输入词散成亮星，验证交互链路。
- 装了下面的真实管线后，后端自动进 **real 模式**，真的现跑 GPT-2。

### 方式 C：换成真实 GPT-2 数据（在你的 4070 Ti 上）
```bash
pip install -r pipeline/requirements.txt
python pipeline/export_embeddings.py --topk 8000
# 生成 web/data/galaxy.json（覆盖样本）+ projector.joblib（供后端 real 模式）
```

---

## 目录结构

```
latent-galaxy/
├─ web/                     # 演示前端（纯静态，离线）
│  ├─ index.html
│  ├─ css/style.css
│  ├─ js/
│  │  ├─ main.js            # 场景/相机/控制/动画循环
│  │  ├─ galaxy.js          # ★星系渲染：GPU 端 PCA⇄UMAP 渐变 + 测谎着色（自定义 shader）
│  │  ├─ ui.js              # 面板/案例库/实时检验交互
│  │  └─ data.js            # 数据加载
│  ├─ vendor/three/         # 本地 vendored Three.js（保证离线）
│  └─ data/
│     └─ galaxy.sample.json # 自带合成样本（克隆即演示）
├─ pipeline/                # 构建期（Python）
│  ├─ generate_mock_data.py # 合成星系（仅标准库，秒级，无需 ML）
│  ├─ export_embeddings.py  # ★真实：GPT-2 词向量 → PCA/UMAP → 失真分 → galaxy.json
│  ├─ metrics.py            # Trustworthiness / 每点失真分
│  └─ requirements.txt
├─ server/                  # 实时后端（Flask）
│  ├─ app.py                # 托管前端 + /api/embed（mock / real 自动切换）
│  └─ requirements.txt
└─ docs/概念入门.md          # 通俗概念 + 汇报备稿
```

---

## 数据格式（前端 / mock / 真实 三者一致）

`web/data/galaxy.json`（或 `.sample.json`）：

```jsonc
{
  "meta": {
    "source": "mock | gpt2:...",
    "count": 4800,
    "clusters": [{ "id": 0, "name": "动物", "color": [r, g, b] }, ...],
    "metrics": { "pca_trustworthiness": 0.93, "umap_trustworthiness": 0.71 }
  },
  "tokens":     ["cat", "dog", ...],   // 长度 N
  "cluster":    [0, 0, 1, ...],        // 每点聚类 id
  "pca":        [[x, y, z], ...],      // PCA 布局（老实）
  "umap":       [[x, y, z], ...],      // UMAP 布局（戏精）
  "distortion": [0.0 .. 1.0, ...],     // 每点失真分，越高越被编造 → 测谎烧红
  "size":       [0.0 .. 1.0, ...]      // 点大小（词频权重）
}
```

---

## 架构：算在构建期，演示只渲染

```
构建期 (Python, 一次)            演示期 (浏览器, 离线零 API)
GPT-2 词向量                      加载 galaxy.json
  → PCA / UMAP → 3D               → Three.js 星系 (GPU 端 PCA⇄UMAP 渐变)
  → 每点失真分 / 可信度            → 一键测谎烧红 + 案例库
  → galaxy.json + projector       → (可选) 调本地后端实时插入老师的输入
```
**这样演示当天不跑模型、不连网、不做可能崩的计算** —— 是"演示稳定"的根本。
"实时检验"由本地后端单独承担，失败也不影响主演示（底座星系一直在）。

---

## 当前进度

✅ 基础框架：星系渲染 + PCA/UMAP 渐变 + 测谎着色 + 案例库 + 实时检验链路 + Python 管线 + 后端骨架。
✅ 渲染升级：**UnrealBloom 辉光后处理** + HDR 亮核 + curl 漂移/呼吸闪烁 + ACES 色调；自动环绕镜头。
✅ **真·近邻连线（意大利面）**：高维真邻居连线，随 PCA⇄UMAP 渐变被扯长——用"边结构"展示"本该相邻的概念被 UMAP 拆散"，把它和热力图区分开。
🔜 待办：接真实 GPT-2 数据出"可信度 vs 紧致度"回归图、5 分钟讲稿 / PPT、实时后端 real 模式联调。

### 推荐演示动线
1. 开场：自动环绕的发光星海（语义聚类色）。
2. 拖 **PCA⇄UMAP**：看同一批点从"重叠老实"被 UMAP 掰成"干净分离"。
3. 开 **🍝 真·近邻连线** 再拖一次：PCA 里短线、UMAP 里被扯成横跨全图的长线 = 撒谎可见。
4. **⚡一键测谎**：切 UMAP + 烧红。
5. **案例库**挑"失真最高的聚类"聚焦，自动高亮 + 连线 + 测谎色。

> 注：这是课程 demo，重点在"研究故事 + 演示"，非生产级。
