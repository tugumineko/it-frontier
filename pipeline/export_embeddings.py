#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
export_embeddings.py —— 真实管线：GPT-2 词向量 → PCA/UMAP 降维 → 失真分 → galaxy.json

跑这一步需要 ML 依赖（见 requirements.txt），建议在你的 4070 Ti 上跑：
    pip install -r pipeline/requirements.txt
    python pipeline/export_embeddings.py --topk 8000

它做的事（对应汇报里"构建期"那一段）：
  1. 取 GPT-2 的输入词嵌入矩阵 wte（约 5 万词 × 768 维）。这就是"模型脑内的词向量"。
  2. 按词频取前 topk 个最常见的词（整张表太大、且低频词是噪声）。
  3. 用 KMeans 给词打"语义聚类"标签，仅用于上色（让星系好看、好讲）。
  4. 两套降维到 3D：PCA（线性、保全局、老实）与 UMAP（非线性、聚类好看、会撒谎）。
  5. 用 metrics.py 算每点失真分（低维假邻居率）+ 两套布局的整体可信度。
  6. 导出 web/data/galaxy.json，格式与 mock 完全一致，前端无需改动。

注：演示现场完全离线、不连任何 API。GPT-2 权重首次会从 HuggingFace 下载并缓存到本地，
    之后断网可跑。这步只在"构建期"做一次。
"""

import os, json, argparse, sys
import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from metrics import (per_point_false_neighbor_rate, per_point_global_distortion,
                     trustworthiness, global_fidelity, normalize_layout, apply_normalizer)

# 给 KMeans 聚类配的颜色盘（HSV 均匀取色）
import colorsys


def cluster_palette(k):
    return [list(colorsys.hsv_to_rgb(i / k, 0.55, 1.0)) for i in range(k)]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.join(here, "..", "web", "data", "galaxy.json")
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gpt2", help="HuggingFace 模型名（默认 gpt2 = small/124M）")
    ap.add_argument("--topk", type=int, default=8000, help="取词频最高的前 K 个词")
    ap.add_argument("--clusters", type=int, default=12, help="KMeans 语义聚类数（仅用于上色）")
    ap.add_argument("--knn", type=int, default=15, help="可信度 / 失真用的近邻数 k")
    ap.add_argument("--out", default=default_out)
    args = ap.parse_args()

    # ---- 1. 取 GPT-2 词向量 ----
    import torch
    from transformers import GPT2Model, GPT2TokenizerFast

    print(f"加载 {args.model} …")
    tok = GPT2TokenizerFast.from_pretrained(args.model)
    model = GPT2Model.from_pretrained(args.model)
    wte = model.get_input_embeddings().weight.detach().cpu().numpy()  # (V, 768)
    print(f"词嵌入矩阵: {wte.shape}")

    # ---- 2. 取前 topk 个词（GPT-2 的 token id 大致按词频排序，越小越常见）----
    topk = min(args.topk, wte.shape[0])
    ids = np.arange(topk)
    X = wte[ids].astype(np.float32)                       # (topk, 768) 高维
    tokens = [tok.decode([int(i)]).strip() or "·" for i in ids]

    # ---- 3. KMeans 语义聚类（仅上色）----
    from sklearn.cluster import KMeans
    print("KMeans 聚类（上色用）…")
    km = KMeans(n_clusters=args.clusters, n_init=4, random_state=42).fit(X)
    cluster = km.labels_.astype(int)
    palette = cluster_palette(args.clusters)

    # ---- 4. 两套降维到 3D（保存模型，供实时后端把新词投到同一空间）----
    from sklearn.decomposition import PCA
    print("PCA → 3D …")
    pca_model = PCA(n_components=3, random_state=42).fit(X)
    pca3 = pca_model.transform(X)

    print("UMAP → 3D …（首次较慢）")
    import umap
    umap_model = umap.UMAP(n_components=3, n_neighbors=args.knn, min_dist=0.1,
                           metric="cosine", random_state=42).fit(X)
    umap3 = umap_model.embedding_

    pca3, pca_norm = normalize_layout(pca3)
    umap3, umap_norm = normalize_layout(umap3)

    # ---- 5. 失真分 + 双指标（局部可信度 + 全局保真）----
    # 关键修正(经真实数据自测)：UMAP 局部反而更可信(保近邻)，它的"谎"在全局。
    # 所以热力 distortion 用『全局失真』(对 UMAP)，测谎才站得住。
    print("计算全局失真分与双指标…")
    distortion = per_point_global_distortion(X, umap3)               # 对 UMAP 测谎(全局)
    pca_trust = round(trustworthiness(X, pca3, k=args.knn), 3)       # 局部可信度
    umap_trust = round(trustworthiness(X, umap3, k=args.knn), 3)
    pca_global = round(global_fidelity(X, pca3), 3)                  # 全局保真
    umap_global = round(global_fidelity(X, umap3), 3)
    print(f"  局部可信度 PCA {pca_trust} / UMAP {umap_trust}（UMAP 高=保近邻）")
    print(f"  全局保真   PCA {pca_global} / UMAP {umap_global}（UMAP 低=全局撒谎）")

    # Shepard 图采样：~600 对点的 高维距离 vs PCA距离 vs UMAP距离（研究图用）
    rng = np.random.default_rng(7)
    Xn = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-8)
    ii = rng.integers(0, topk, 600); jj = rng.integers(0, topk, 600)
    dHi = 1.0 - (Xn[ii] * Xn[jj]).sum(1)
    dPca = np.linalg.norm(pca3[ii] - pca3[jj], axis=1)
    dUmap = np.linalg.norm(umap3[ii] - umap3[jj], axis=1)
    norm01 = lambda a: ((a - a.min()) / (a.max() - a.min() + 1e-8))
    shepard = {"dHi": [round(float(v),3) for v in norm01(dHi)],
               "dPca": [round(float(v),3) for v in norm01(dPca)],
               "dUmap": [round(float(v),3) for v in norm01(dUmap)]}

    # ---- 真·近邻连线（①意大利面）：高维(768D)真邻居，PCA 短、UMAP 被扯长 ----
    from sklearn.neighbors import NearestNeighbors
    n_sample = min(360, topk)
    sample_idx = np.linspace(0, topk - 1, n_sample).astype(int)
    nn_hi = NearestNeighbors(n_neighbors=6).fit(X)
    _, nb = nn_hi.kneighbors(X[sample_idx])
    seen, links = set(), []
    for s, i in enumerate(sample_idx):
        for j in nb[s, 1:]:
            a, b = (int(i), int(j)) if i < j else (int(j), int(i))
            if (a, b) in seen:
                continue
            seen.add((a, b)); links.append([a, b])

    # 词频近似用 1/(id+1) 当大小权重（常见词更大更亮）
    size = (1.0 - ids / topk).astype(np.float32)

    # ---- 6. 导出（与 mock 同格式）----
    data = {
        "meta": {
            "source": f"gpt2:{args.model}",
            "count": topk,
            "clusters": [{"id": i, "name": f"簇{i}", "color": palette[i]} for i in range(args.clusters)],
            "metrics": {"pca_trustworthiness": pca_trust, "umap_trustworthiness": umap_trust,
                        "pca_global": pca_global, "umap_global": umap_global},
            "shepard": shepard,
            "notes": "GPT-2 词向量真实数据；distortion = UMAP 全局失真(1-Spearman)；UMAP 局部诚实、全局撒谎",
        },
        "tokens": tokens,
        "cluster": cluster.tolist(),
        "pca": [[round(float(v), 2) for v in p] for p in pca3],
        "umap": [[round(float(v), 2) for v in p] for p in umap3],
        "distortion": [round(float(v), 3) for v in distortion],
        "size": [round(float(v), 3) for v in size],
        "links": links,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"✓ 导出 {topk} 个词 → {args.out}")

    # ---- 7. 保存"投影器 bundle"，供 server/app.py 把老师的新输入投到同一星系 ----
    import joblib
    bundle_path = os.path.join(os.path.dirname(os.path.abspath(args.out)), "projector.joblib")
    joblib.dump({
        "model": args.model,
        "pca": pca_model, "umap": umap_model,
        "pca_norm": pca_norm, "umap_norm": umap_norm,
        "knn": args.knn,
    }, bundle_path)
    print(f"✓ 保存投影器 → {bundle_path}（实时后端用）")


if __name__ == "__main__":
    main()
