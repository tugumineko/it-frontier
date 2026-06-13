#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diagnose_metrics.py —— 自测"测谎预期"是否成立。

背景：项目原始叙事"UMAP 局部撒谎"在真实 GPT-2 数据上不成立——
  UMAP 被设计为保局部近邻，所以 *局部可信度* 反而比 PCA 高。
  UMAP 真正的"谎"在 *全局结构*（簇间距离/整体布局/视觉分离）。
本脚本同时测两类指标，看哪类指标能支撑"越好看越骗你"：
  1) 局部可信度 Trustworthiness（UMAP 应更高 → 局部 UMAP 不撒谎）
  2) 全局距离保真 Spearman（高维距离 vs 低维距离的秩相关，UMAP 应更低 → 全局 UMAP 撒谎）
"""
import os, json, sys
import numpy as np
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "web", "data", "galaxy.json")


def load_highdim(n):
    from transformers import GPT2Model
    m = GPT2Model.from_pretrained("gpt2")
    wte = m.get_input_embeddings().weight.detach().cpu().numpy()[:n].astype(np.float32)
    # 余弦距离 → 先 L2 归一化
    wte /= (np.linalg.norm(wte, axis=1, keepdims=True) + 1e-8)
    return wte


def ranks(a):
    return np.argsort(np.argsort(a, axis=1), axis=1).astype(np.float32)


def global_spearman(X, Y, n_query=400, seed=0):
    """每个采样点：它到所有点的距离向量，高维 vs 低维 的 Spearman，再平均。"""
    rng = np.random.default_rng(seed)
    N = X.shape[0]
    q = rng.choice(N, size=min(n_query, N), replace=False)
    # 高维余弦距离（X 已归一化）：1 - X·Xq^T
    dHi = 1.0 - X[q] @ X.T              # (q, N)
    # 低维欧氏距离
    dLo = np.sqrt(((Y[q][:, None, :] - Y[None, :, :]) ** 2).sum(-1))  # (q, N)
    rHi, rLo = ranks(dHi), ranks(dLo)
    # 逐行 Pearson(秩) = Spearman
    rHi -= rHi.mean(1, keepdims=True); rLo -= rLo.mean(1, keepdims=True)
    num = (rHi * rLo).sum(1)
    den = np.sqrt((rHi**2).sum(1) * (rLo**2).sum(1)) + 1e-8
    return float((num / den).mean())


def main():
    with open(DATA, encoding="utf-8") as f:
        g = json.load(f)
    pca = np.asarray(g["pca"], dtype=np.float32)
    umap = np.asarray(g["umap"], dtype=np.float32)
    n = len(g["tokens"])
    print(f"点数 {n}")

    print("加载高维 GPT-2 词向量…")
    X = load_highdim(n)

    from sklearn.manifold import trustworthiness
    print("\n=== 1) 局部可信度 Trustworthiness（k=15，越高越保局部）===")
    tp = trustworthiness(X, pca, n_neighbors=15)
    tu = trustworthiness(X, umap, n_neighbors=15)
    print(f"  PCA  {tp:.3f}")
    print(f"  UMAP {tu:.3f}   →  {'UMAP 局部更可信(符合 UMAP 设计)' if tu>tp else 'PCA 局部更可信'}")

    print("\n=== 2) 全局距离保真 Spearman（越高越保全局，越低越撒谎）===")
    gp = global_spearman(X, pca)
    gu = global_spearman(X, umap)
    print(f"  PCA  {gp:.3f}")
    print(f"  UMAP {gu:.3f}   →  {'UMAP 全局更失真(支持“越好看越骗你”)' if gu<gp else 'UMAP 全局反而更好'}")

    print("\n=== 结论 ===")
    if tu > tp and gu < gp:
        print("  ✓ 修正叙事成立：UMAP 局部诚实(保近邻)、全局撒谎(簇间距离/布局是假的)。")
        print("    → 热力 distortion 应改用『全局失真』，测谎才站得住。")
    elif gu < gp:
        print("  ~ 全局指标支持测谎，局部不支持——按全局叙事走。")
    else:
        print("  ✗ 两个指标都不支持简单测谎，需要换更细的局部失真度量(如假邻居在视觉紧致簇上的分布)。")


if __name__ == "__main__":
    main()
