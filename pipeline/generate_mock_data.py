#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_mock_data.py —— 生成"合成词向量星系"，供前端在没有 ML 依赖时直接演示。

为什么需要它：
  真实管线 export_embeddings.py 需要 torch / transformers / umap-learn（要装、要下模型）。
  本脚本只用 Python 标准库，几秒生成一个"长得像那么回事"的星系，
  让前端骨架一克隆就能跑、也方便你先把渲染调好。

它讲的是同一个故事（且是诚实的合成）：
  - 在一个低维"概念空间"里放若干语义聚类，有些聚类天生就靠得近（真实近邻）。
  - PCA 布局：保留全局结构 → 近邻聚类仍重叠（老实但糊）。
  - UMAP 布局：把每个聚类甩到球面上彼此拉开 → 好看，但摧毁了真实的全局距离（戏精在撒谎）。
  - 每点失真分：它在"概念空间"里的近邻，被 UMAP 拆散得越狠 → 失真越高 → 测谎时烧得越红。

输出格式与 export_embeddings.py 完全一致（见 README「数据格式」）。
"""

import os, json, math, random, argparse, sys

try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 控制台默认 GBK，避免打印中文/符号崩
except Exception:
    pass

random.seed(20260613)

# ---- 语义聚类定义：名字 / 颜色(RGB 0..1) / 代表词 ----
CLUSTERS = [
    ("动物", [0.95, 0.55, 0.35], ["cat","dog","tiger","wolf","rabbit","horse","bear","fox","lion","deer","mouse","sheep"]),
    ("数字", [0.45, 0.75, 1.00], ["one","two","three","four","five","six","seven","eight","nine","ten","hundred","thousand"]),
    ("颜色", [0.85, 0.45, 0.95], ["red","blue","green","yellow","purple","orange","black","white","pink","gray","gold","silver"]),
    ("国家", [0.40, 0.90, 0.65], ["china","france","japan","brazil","egypt","canada","india","spain","italy","russia","kenya","peru"]),
    ("情绪", [1.00, 0.80, 0.35], ["happy","sad","angry","afraid","calm","proud","jealous","lonely","excited","bored","anxious","glad"]),
    ("食物", [0.95, 0.40, 0.45], ["bread","rice","apple","cheese","soup","cake","noodle","steak","salad","sugar","coffee","honey"]),
    ("身体", [0.60, 0.85, 0.95], ["hand","eye","heart","brain","leg","mouth","ear","nose","finger","skin","bone","blood"]),
    ("天气", [0.50, 0.65, 1.00], ["rain","snow","wind","storm","cloud","sunny","fog","thunder","frost","heat","cold","mist"]),
    ("职业", [0.80, 0.70, 0.40], ["doctor","teacher","lawyer","farmer","pilot","artist","nurse","judge","chef","writer","singer","miner"]),
    ("动作", [0.70, 0.50, 0.90], ["run","jump","walk","swim","fly","climb","throw","catch","push","pull","kick","crawl"]),
    ("亲属", [0.95, 0.65, 0.70], ["mother","father","sister","brother","aunt","uncle","cousin","son","daughter","grandma","nephew","niece"]),
    ("乐器", [0.55, 0.95, 0.85], ["piano","violin","guitar","drum","flute","harp","cello","trumpet","oboe","banjo","viola","horn"]),
]

# 概念空间里，刻意让某些聚类彼此靠近（真实近邻），制造"UMAP 会撒谎"的素材。
# 这里给每个聚类一个 8 维概念坐标；相近的语义给相近的坐标。
CONCEPT = {
    "动物": [0.2, 0.1, 0.0, 0.3, 0.1, 0.0, 0.2, 0.1],
    "亲属": [0.9, 0.8, 0.1, 0.2, 0.0, 0.1, 0.1, 0.0],  # 和"身体""情绪"概念上偏近（都关乎人）
    "身体": [0.8, 0.7, 0.2, 0.1, 0.1, 0.0, 0.0, 0.1],
    "情绪": [0.85, 0.6, 0.3, 0.0, 0.2, 0.1, 0.0, 0.0],
    "食物": [0.3, 0.2, 0.9, 0.8, 0.1, 0.0, 0.1, 0.2],
    "动作": [0.1, 0.0, 0.2, 0.1, 0.9, 0.8, 0.1, 0.0],
    "数字": [0.0, 0.1, 0.1, 0.0, 0.1, 0.0, 0.9, 0.85],
    "颜色": [0.4, 0.1, 0.5, 0.2, 0.3, 0.6, 0.2, 0.1],
    "国家": [0.6, 0.2, 0.1, 0.5, 0.4, 0.2, 0.3, 0.7],
    "天气": [0.2, 0.3, 0.6, 0.1, 0.2, 0.1, 0.5, 0.4],
    "职业": [0.7, 0.5, 0.2, 0.3, 0.5, 0.4, 0.2, 0.2],
    "乐器": [0.1, 0.4, 0.4, 0.6, 0.2, 0.7, 0.4, 0.3],
}


def dist(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def neighbor_set(centers, idx, k):
    order = sorted(range(len(centers)), key=lambda j: dist(centers[idx], centers[j]))
    return set(order[1:k + 1])  # 跳过自己


def fib_sphere(i, n):
    """把 n 个聚类均匀撒到球面（模拟 UMAP 把聚类彼此拉开、忽略真实距离）。"""
    ga = math.pi * (3 - math.sqrt(5))
    y = 1 - (i / max(1, n - 1)) * 2
    r = math.sqrt(max(0.0, 1 - y * y))
    th = ga * i
    return [math.cos(th) * r, y, math.sin(th) * r]


def build(n_points):
    names = [c[0] for c in CLUSTERS]
    K = len(CLUSTERS)
    concept_centers = [CONCEPT[nm] for nm in names]

    # PCA 布局中心：保留概念空间的全局结构（取前 3 维 + 轻微缩放）
    pca_centers = [[c[0] * 90 - 45, c[1] * 90 - 45, c[2] * 90 - 45] for c in concept_centers]
    # UMAP 布局中心：球面均匀铺开，刻意无视真实概念距离
    umap_centers = [[v * 70 for v in fib_sphere(i, K)] for i in range(K)]

    # —— 聚类级"全局失真"：概念空间近邻集合 vs UMAP 近邻集合 的不一致度 ——
    kk = 4
    concept_nb = [neighbor_set(concept_centers, i, kk) for i in range(K)]
    umap_nb = [neighbor_set(umap_centers, i, kk) for i in range(K)]
    cluster_lie = []
    for i in range(K):
        inter = len(concept_nb[i] & umap_nb[i])
        union = len(concept_nb[i] | umap_nb[i]) or 1
        cluster_lie.append(1.0 - inter / union)  # Jaccard 距离，0..1

    # —— PCA / UMAP 的整体可信度（聚类级近邻保持率），给读数用 ——
    def trust(centers):
        keep = 0
        for i in range(K):
            nb = neighbor_set(centers, i, kk)
            keep += len(nb & concept_nb[i]) / kk
        return keep / K
    pca_trust = round(0.55 + 0.45 * trust(pca_centers), 3)   # 接近概念空间 → 高
    umap_trust = round(0.45 + 0.45 * trust(umap_centers), 3) # 被打乱 → 低

    tokens, cluster, pca, umap, distortion, size = [], [], [], [], [], []
    per = max(1, n_points // K)

    for ci, (name, color, words) in enumerate(CLUSTERS):
        for _ in range(per):
            # 在概念空间里采一个点（决定它有多"靠边界"）
            jitter = [random.gauss(0, 0.06) for _ in range(8)]
            cpt = [concept_centers[ci][d] + jitter[d] for d in range(8)]
            # 它离哪个"别的聚类"最近？越近 = 越在边界 = UMAP 越会误导它
            others = sorted((dist(cpt, concept_centers[j]), j) for j in range(K) if j != ci)
            d_near = others[0][0]
            boundary = math.exp(-d_near * 3.0)  # 0..1，越靠边界越大

            # 失真 = 该聚类全局撒谎程度 × (基底 + 边界增强) + 噪声
            dval = cluster_lie[ci] * (0.55 + 0.7 * boundary) + random.gauss(0, 0.05)
            dval = max(0.0, min(1.0, dval))

            # PCA 坐标：聚类中心 + 较大类内散布（老实但糊、会重叠）
            p = [pca_centers[ci][d] + random.gauss(0, 11) for d in range(3)]
            # UMAP 坐标：聚类中心 + 很小类内散布（好看、紧致、分得开）
            u = [umap_centers[ci][d] + random.gauss(0, 3.2) for d in range(3)]

            tokens.append(random.choice(words))
            cluster.append(ci)
            pca.append([round(x, 2) for x in p])
            umap.append([round(x, 2) for x in u])
            distortion.append(round(dval, 3))
            size.append(round(random.random() ** 1.5, 3))  # 少量大星 + 多数小星

    meta = {
        "source": "mock",
        "count": len(tokens),
        "clusters": [{"id": i, "name": CLUSTERS[i][0], "color": CLUSTERS[i][1]} for i in range(K)],
        "metrics": {"pca_trustworthiness": pca_trust, "umap_trustworthiness": umap_trust},
        "notes": "合成数据：用于无 ML 依赖时演示与调试渲染；真实数据请用 export_embeddings.py 覆盖 galaxy.json",
    }
    return {"meta": meta, "tokens": tokens, "cluster": cluster,
            "pca": pca, "umap": umap, "distortion": distortion, "size": size}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.join(here, "..", "web", "data", "galaxy.sample.json")
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=4800, help="点数（默认 4800）")
    ap.add_argument("--out", default=default_out, help="输出 json 路径")
    args = ap.parse_args()

    data = build(args.n)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    m = data["meta"]["metrics"]
    print(f"✓ 生成 {data['meta']['count']} 个点 → {args.out}")
    print(f"  PCA 可信度 {m['pca_trustworthiness']} | UMAP 可信度 {m['umap_trustworthiness']}（越低越会骗人）")


if __name__ == "__main__":
    main()
