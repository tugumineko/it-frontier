# 潜空间银河 · UMAP 测谎仪 (Latent Galaxy · UMAP Lie Detector)

> 把大模型内部的**词向量**渲染成一片可以飞行穿梭的 3D 星系，再叠一层"测谎滤镜"，
> 当场用数字证明——**你在降维图里看到的那些漂亮、分得很开的聚类，很大一部分是降维算法（UMAP/t-SNE）编出来的，不是模型里真实存在的结构。**

信息技术前沿创新课程项目。方向：**可解释性 / 表征可视化的可信度审计**。一句话立意：**越好看，越可能在骗你。**

---

## 这是什么 / 研究点

- 大模型把每个词变成一串高维数字（GPT-2 是 768 维）——意思相近的词坐标也相近。这就是"潜空间"。
- 人看不了 768 维，必须降维到 3 维。`UMAP / t-SNE` 为了让聚类好看，会**扭曲真实的远近关系**（像世界地图把格陵兰画得比非洲还大）。
- 本项目做一个浏览器内的"测谎仪"：用 **Trustworthiness（可信度）** 给每个点算"失真分"，把被算法编造的聚类**烧红**，并给出**"视觉紧致度 vs 可信度"负相关**这一可证伪结论。

详见 [`docs/概念入门.md`](docs/概念入门.md)（为不熟 AI 的人写的通俗入门 + 汇报问答备稿）。

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

✅ 基础框架：前端星系渲染 + PCA/UMAP 渐变 + 测谎着色 + 案例库 + 实时检验链路 + Python 管线 + 后端骨架。
🔜 待办：接真实 GPT-2 数据出"可信度 vs 紧致度"回归图、精选案例库、Bloom 辉光、5 分钟讲稿 / PPT。

> 注：这是课程 demo，重点在"研究故事 + 演示"，非生产级。
