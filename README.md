# 代码词义星海 · 看模型怎么分辨代码里的一词多义

> 贴一段代码，看模型按上下文区分同一个符号的不同含义（`key` 是字典键还是密钥），并让 Agent 判读某个符号在此处的含义与依据。

信息技术前沿创新课程项目。方向：大模型可解释性与编码 Agent 的可视化。用 ECNU 平台 API：`ecnu-embedding-small`（BGE-M3）做向量，`ecnu-max` 做 Agent 判读；前端 Three.js 星海。不依赖本地大模型。

---

## 快速开始

1. 复制 `server/secrets.example.json` 为 `server/secrets.json`，填 ECNU 的 `base_url` 和 `api_key`（已 gitignore，不会上传）。
2. 装依赖：`pip install flask scikit-learn umap-learn joblib numpy`。
3. 启动：`python server/app.py`，浏览器开 http://127.0.0.1:5000。

## 现场看什么

1. **贴代码 → 投进星海**：每个标识符按所在代码行用 bge 编码、投到星海。同一个符号在不同上下文落到不同区，鼠标移上去看它此处的最近邻。
2. **多义符号案例**（key / token / class / port / stream / pool）：星海里标出两个义项的落点和各自最近邻。
3. **Agent 判读**：填一个符号，`ecnu-max` 判断它在这段代码里的含义、依据哪些行、置信多少。

## 重建底图数据

```bash
python pipeline/export_code_galaxy.py   # 调 bge 编码代码语料 → galaxy.json + projector.joblib
```

## 文档

- [调研结果-Agent代码一词多义](docs/调研结果-Agent代码一词多义.md)、[需求清单-Agent代码一词多义](docs/需求清单-Agent代码一词多义.md)：本方向的调研与改造清单。
- `docs/讲解文档.md`、`docs/项目说明.md`、`docs/概念入门.md`：早期「自然语言词义星海（GPT-2）」版本的讲稿，方向已转代码版，内容待更新。

## 方向演进

早期用 GPT-2 词向量做自然语言的「词义星海」，后转向「代码一词多义 + 编码 Agent」，改用 ECNU API（bge + ecnu-max），不再依赖本地模型。

> 课程 demo，重点在研究故事与演示，非生产级。
