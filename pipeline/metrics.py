#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
metrics.py —— 降维"可信度"度量（真实管线用）。

核心思想（一句话）：
  一个点在低维图(2D/3D)里看起来的邻居，在原始高维里到底还是不是邻居？
  不是 → 这个聚类是降维算法"编"出来的 → 失真高 → 测谎时烧红。

提供两类：
  1) trustworthiness(X_high, X_low, k)：整体可信度（sklearn 标准指标），给读数用。
  2) per_point_false_neighbor_rate(X_high, X_low, k)：每点失真分（0..1），给"测谎着色"用。
"""

import numpy as np
from sklearn.neighbors import NearestNeighbors
from sklearn.manifold import trustworthiness as _sk_trustworthiness


def trustworthiness(X_high, X_low, k=15):
    """整体可信度，0..1，越高越忠实。直接用 sklearn 实现。"""
    return float(_sk_trustworthiness(X_high, X_low, n_neighbors=k))


def per_point_false_neighbor_rate(X_high, X_low, k=15):
    """
    每点失真分：低维近邻里有多少"假邻居"（在高维里其实不是近邻）。
    返回 shape=(N,) 的 0..1 数组，越大 = 这个点周围越是被算法编造出来的。
    """
    nn_high = NearestNeighbors(n_neighbors=k + 1).fit(X_high)
    nn_low = NearestNeighbors(n_neighbors=k + 1).fit(X_low)
    _, idx_high = nn_high.kneighbors(X_high)
    _, idx_low = nn_low.kneighbors(X_low)

    n = X_high.shape[0]
    out = np.zeros(n, dtype=np.float32)
    for i in range(n):
        high = set(idx_high[i, 1:])   # 跳过自己
        low = set(idx_low[i, 1:])
        false_neighbors = len(low - high)  # 低维说是邻居、高维不认的
        out[i] = false_neighbors / k
    return out


def fit_normalizer(X, scale=70.0):
    """学出"居中+缩放"参数，便于之后把新点投到同一空间（实时后端要用）。"""
    X = np.asarray(X, dtype=np.float32)
    center = X.mean(axis=0)
    r = float(np.percentile(np.linalg.norm(X - center, axis=1), 98)) or 1.0
    return {"center": center.tolist(), "r": r, "scale": scale}


def apply_normalizer(X, params):
    X = np.asarray(X, dtype=np.float32) - np.asarray(params["center"], dtype=np.float32)
    return (X / params["r"]) * params["scale"]


def normalize_layout(X, scale=70.0):
    """把一套 3D 坐标居中并缩放到大致 [-scale, scale]，方便前端相机统一。"""
    params = fit_normalizer(X, scale)
    return apply_normalizer(X, params), params
