# 代码符号语义探索器 (Latent Code-Symbol Galaxy)

> 输入一段代码，让 agent（ecnu-max）判断每个符号在每一处的含义，用 bge 向量把同名符号的不同用法投成 3D 星海——**代码 ↔ 星海 ↔ 判读卡三视图联动**，一眼看出「同名异义」。

信息技术前沿创新课程项目。方向：编码 Agent 的代码理解 + 可解释性可视化。用 ECNU 平台 API（`ecnu-embedding-small` 取向量、`ecnu-max` 判读），前端 Three.js，不依赖本地大模型。

---

## 快速开始

1. 复制 `server/secrets.example.json` 为 `server/secrets.json`，填 ECNU 的 `base_url` 和 `api_key`（已 gitignore，不会上传）。
2. 装依赖：`pip install -r server/requirements.txt`。
3. 启动：`python server/app.py`，浏览器开 http://127.0.0.1:5000。

## 怎么用（三视图联动）

1. **左侧粘贴代码 → 点「分析」**：后端对每个标识符的每一次出现取 ±2 行上下文窗口，用 bge 编码，并一次性让 ecnu-max 判读每处的义项；当场降维成星海。
2. **切「按义项 / 按符号名」着色**：按符号名时同名同色像一团，按义项时同名符号按 agent 判读裂成不同色——这就是一词多义。
3. **点代码里的符号，或点星海里的点**：三视图联动——判读卡显示含义/依据/置信/最近邻，星海高亮同义项并连最近邻，代码面板高亮对应行。
4. **导出 / 导入星海数据**（JSON）：当前分析可存盘、离线导入回放（无需后端）。
5. **改上下文重判**：直接改左侧代码再点「分析」，看符号义项与星海落点随上下文改变。

## 架构

- **后端** `server/app.py`：`/api/analyze(POST {code})` 一次出齐——occurrence 级 bge 向量 + 当场 fit PCA/UMAP + 一次 ecnu-max 判读所有多义符号；不依赖任何预设底图。
- **前端** `web/`：Three.js 星海 + 代码面板 + 判读卡，三者订阅同一个 `selection` 信号联动。

## 文档

`docs/` 下有方向演进过程中的调研与设计（部分为早期「词义星海」版本，叙事以本 README 为准）。

> 课程 demo，重点在研究故事与演示，非生产级。
