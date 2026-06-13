# 调研结果：Agent 如何判断代码里的一词多义

> 目标：把现有「词义星海」从自然语言一词多义，迁移到「代码里的一词多义」，并尽量贴近今年很火的编码 Agent。本文调研相关研究与工具，对比编码 Agent 与传统对话大模型的区别，给出两条可行路径和推荐。不追求严格理论，只为按现有可视化框架做出展示。

---

## 一、代码里的「一词多义」是什么

自然语言里 bank 有银行和河岸两义。代码里同样普遍，而且判断它正是编码 Agent 读代码时一直在做的事。

- 同一个标识符在不同上下文含义不同：`run`（执行程序 / 跑测试 / 一段连续记录）、`pool`（线程池 / 内存池 / 连接池）、`key`（字典键 / 加密密钥 / 主键）、`cell`、`stream`、`client`、`token`。
- 同名符号在不同作用域或文件指向不同实体：两个模块各自的 `User`、`config`、`i`。
- 同一个关键字跨语言含义不同：`static`、`final`。

## 二、相关研究与工具

这一节按三类列出对口工作，每条给一句话和对本项目的借鉴。

### 代码上下文嵌入（和本项目方法最对口）

| 工作 | 一句话 | 对本项目的借鉴 |
|---|---|---|
| CodeBERT | 代码加自然语言的双模态预训练模型，12 层、768 维，给每个 code token 上下文嵌入 | 直接替换 GPT-2，标识符的逐层向量照搬现有全套 |
| GraphCodeBERT | 在 CodeBERT 上加入数据流结构 | 消歧更强（懂变量流向），但预处理更复杂 |
| Code Attention in BERT | 上层富含代码语义、靠自注意力聚合上下文 | 佐证「取中间偏上层」的选层思路 |
| 标识符嵌入（Identifier Embeddings） | 代码向量能捕捉相似与类比、按软件工程上下文消歧 | 底图语料从英文词换成代码标识符 |

### 编码 Agent 与上下文检索（今年最热）

| 工作 | 一句话 | 对本项目的借鉴 |
|---|---|---|
| 编码 Agent（Claude Code / SWE-agent / OpenHands 等） | 读代码、检索上下文、判断、改代码的循环 | Agent 判断符号含义就是代码一词多义的现场 |
| 上下文检索是质量关键 | 模型只能推理它看得到的代码，注入哪些上下文决定成败 | 「注入了哪些上下文」正是可视化对象 |
| ContextBench / SWE-Explore（2026） | Agent 检索上下文、探索仓库的基准 | 前沿挂钩与样例来源 |
| Interpreting Agentic Systems（2026） | Agentic 可解释性，把解释当成达成目标的手段 | 项目立意的前沿坐标 |

### 可视化技法

| 工作 | 一句话 | 对本项目的借鉴 |
|---|---|---|
| Parallax | 用代数公式显式定义可解释的投影轴 | 强化 B 义项轴，可推广到任意语义轴 |
| ViConBERT 可视化 | 确认模型把多义词义项聚成分离的簇 | 佐证星海能分义项 |

## 三、编码 Agent 与传统对话大模型的区别（基于公开资料）

这一节回答你关心的「区别」与「能迁移多少」，全部基于公开知识，不涉及任何非公开实现。

传统对话大模型做的是一次问答：输入文本、输出文本，没有外部行动，能看到的只有对话窗口里的内容。判断代码一词多义时，它只能凭 prompt 里给到的片段猜。

编码 Agent 是在大模型外面套了一个循环：调用工具（读文件、跑命令、搜索符号）、观察结果、再决策，反复进行；并且会主动检索仓库里的相关代码注入上下文，还维护任务状态与计划。判断一个符号此处的含义时，它会主动去查这个符号的定义、调用处、数据流，把证据注入后再判断。

所以「Agent 判断一词多义」可以拆成两步：检索并注入相关上下文，然后推理消歧。它的可解释抓手是「注入了什么、为什么这样判」。

可迁移到本项目的程度：

- 表示层（embedding 星海、逐层可分度、义项轴、最近邻、案例）与模型类型无关，换成 CodeBERT 可以几乎原样复用。
- Agent 层（工具循环、上下文检索、判读理由）是传统对话模型没有的，需要新做可视化，例如高亮 Agent 注入的代码行、画出它的检索轨迹。这一层是新增，不是迁移。

一句话：embedding 可视化能整体迁移，Agent 的「判读过程」是要新搭的一层。

## 四、两条可行路径

### 路径①：换成代码上下文嵌入模型（最小改动，免 API）

把 GPT-2 换成本地 CodeBERT 或 GraphCodeBERT。输入代码片段，取标识符 token 的逐层上下文向量。现有的星海、逐层可分度、义项轴、最近邻、案例全套几乎原样复用，只换 embedding 源和底图语料（改成代码标识符）。不需要 API，CodeBERT 本地可跑。

### 路径②：用 LLM Agent 判读（贴 Agent 热点，需 API）

给一段代码和一个有歧义的符号，调用 chat API，让模型判断它此处的含义，并说明它依据或注入了哪些上下文（定义、调用、数据流）。可视化 Agent 的判断结果，并高亮它注入的代码行。这更新颖、更贴「Agent 注入信息」，但要新设计可视化（不是 embedding 空间里的点），理论性偏弱，且依赖 API 稳定。

### 对比

| 维度 | 路径① CodeBERT | 路径② LLM Agent |
|---|---|---|
| 改动量 | 小（换模型和语料） | 大（新可视化加 API 层） |
| 是否需要 API | 不需要 | 需要 |
| 复用现有框架 | 几乎全套 | 部分（星海可留作背景） |
| Agent 味道 | 中（代码版一词多义） | 高（Agent 现场判读） |
| 理论扎实度 | 高（有模型支撑） | 中（启发式判读） |
| 演示稳定性 | 高（离线） | 取决于 API |

一个重要事实：通用嵌入 API（如 OpenAI text-embedding）只给整段一个向量，给不了 token 级、更给不了逐层，所以嵌入路径必须用本地 CodeBERT，不能用嵌入 API。需要 API 的只有路径②的 chat 判读。

## 五、推荐

以路径①为主体：本地 CodeBERT 展示代码标识符的一词多义星海，复用现有全套，快速稳定、免 API。把路径②作为叠加的「Agent 判读面板」：给一段代码和一个符号，用 chat API 现场判读它的含义并高亮注入的上下文。这样既快出成果，又挂上 Agent 亮点，两层各自独立、互不拖累。

详细缺口和改造项见同目录《需求清单-Agent代码一词多义.md》。

## 六、参考来源

- [CodeBERT](https://github.com/microsoft/CodeBERT) · [GraphCodeBERT (ICLR 2021)](https://huang.isis.vanderbilt.edu/cs8395/readings/graphcodebert.pdf) · [Code Attention in BERT (arXiv 2204.10200)](https://arxiv.org/pdf/2204.10200)
- [Does BERT Make Any Sense? (arXiv 1909.10430)](https://arxiv.org/pdf/1909.10430) · [Semantic Source Code Models Using Identifier Embeddings](https://www.researchgate.net/publication/332439394_Semantic_Source_Code_Models_Using_Identifier_Embeddings)
- [Parallax (arXiv 1905.12099)](https://ar5iv.labs.arxiv.org/html/1905.12099)
- [A Survey on Code Generation with LLM-based Agents (arXiv 2508.00083)](https://arxiv.org/html/2508.00083v1) · [ContextBench (arXiv 2602.05892)](https://arxiv.org/html/2602.05892v3) · [SWE-Explore (arXiv 2606.07297)](https://arxiv.org/html/2606.07297v1)
- [Interpreting Agentic Systems (arXiv 2601.17168)](https://arxiv.org/pdf/2601.17168) · [Agentic Coding in 2026 (Sourcegraph)](https://sourcegraph.com/blog/agentic-coding)
