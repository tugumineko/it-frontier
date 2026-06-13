#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py —— 本地实时后端：托管前端 + 提供 /api/embed（把老师的新输入投进同一星系）。

两种运行模式（自动选择）：
  · real 模式：检测到 ML 依赖 + 已运行 export_embeddings.py 生成的 projector.joblib，
               则真的加载 GPT-2，把新词向量用同一套 PCA/UMAP 投影器投到星系里。
               —— 这就是你跟老师说的"现场给任意输入、我现跑给您看"的真实能力。
  · mock 模式：没有 ML 依赖也没关系，用 galaxy.sample.json 的聚类中心把输入词
               散成亮星，纯粹让"实时检验"这条交互链路在骨架阶段就能跑通、好调试。

启动：
    pip install -r server/requirements.txt   # 至少要 flask；real 模式还需 pipeline 的依赖
    python server/app.py                      # 然后浏览器开 http://127.0.0.1:5000
现场完全本地、不连任何外部 API。
"""

import os, json, hashlib, sys
from flask import Flask, request, jsonify, send_from_directory

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "web")
DATA = os.path.join(WEB, "data")

app = Flask(__name__, static_folder=None)

# ---------- 尝试进入 real 模式 ----------
REAL = None  # 成功则是一个 dict，存模型与投影器


def try_load_real():
    bundle = os.path.join(DATA, "projector.joblib")
    if not os.path.exists(bundle):
        return None
    try:
        import numpy as np, joblib
        from transformers import GPT2Model, GPT2TokenizerFast
        from sklearn.neighbors import NearestNeighbors

        b = joblib.load(bundle)
        tok = GPT2TokenizerFast.from_pretrained(b["model"])
        model = GPT2Model.from_pretrained(b["model"])
        wte = model.get_input_embeddings().weight.detach().cpu().numpy()

        # 加载星系参考（用于给新点估失真：落在多"红"的区域）
        with open(os.path.join(DATA, "galaxy.json"), encoding="utf-8") as f:
            g = json.load(f)
        umap_ref = np.asarray(g["umap"], dtype=np.float32)
        dist_ref = np.asarray(g["distortion"], dtype=np.float32)
        nn = NearestNeighbors(n_neighbors=min(15, len(umap_ref))).fit(umap_ref)

        print("✓ real 模式：GPT-2 + 投影器已加载")
        return {"np": np, "tok": tok, "wte": wte, "b": b, "nn": nn, "dist_ref": dist_ref}
    except Exception as e:
        print(f"· real 模式不可用（{e.__class__.__name__}: {e}），回退 mock")
        return None


def _apply_norm(X, p):
    # 与 pipeline/metrics.apply_normalizer 等价，内联以免后端依赖 pipeline 路径
    np = REAL["np"]
    X = np.asarray(X, dtype=np.float32) - np.asarray(p["center"], dtype=np.float32)
    return (X / p["r"]) * p["scale"]


def embed_real(text):
    np = REAL["np"]; tok = REAL["tok"]; wte = REAL["wte"]; b = REAL["b"]
    apply_normalizer = _apply_norm
    ids = tok.encode(text)[:64]
    if not ids:
        return []
    X = wte[np.asarray(ids)]
    pca3 = apply_normalizer(b["pca"].transform(X), b["pca_norm"])
    umap3 = apply_normalizer(b["umap"].transform(X), b["umap_norm"])
    # 失真：新点在 UMAP 空间落点附近的星系点平均失真
    d_idx = REAL["nn"].kneighbors(umap3, return_distance=False)
    dvals = REAL["dist_ref"][d_idx].mean(axis=1)
    out = []
    for i, tid in enumerate(ids):
        out.append({
            "token": tok.decode([tid]).strip() or "·",
            "pca": [round(float(v), 2) for v in pca3[i]],
            "umap": [round(float(v), 2) for v in umap3[i]],
            "distortion": round(float(dvals[i]), 3),
        })
    return out


# ---------- mock 模式 ----------
_MOCK = None


def mock_galaxy():
    global _MOCK
    if _MOCK is None:
        path = os.path.join(DATA, "galaxy.sample.json")
        with open(path, encoding="utf-8") as f:
            _MOCK = json.load(f)
    return _MOCK


def embed_mock(text):
    import statistics
    g = mock_galaxy()
    clusters = g["meta"]["clusters"]
    K = len(clusters)
    # 每个聚类的中心 + 平均失真（现算，骨架阶段够用）
    centers = {i: {"pca": [0,0,0], "umap": [0,0,0], "n": 0, "dsum": 0.0} for i in range(K)}
    for i in range(len(g["tokens"])):
        c = g["cluster"][i]
        for k in ("pca", "umap"):
            for j in range(3):
                centers[c][k][j] += g[k][i][j]
        centers[c]["n"] += 1
        centers[c]["dsum"] += g["distortion"][i]
    for c in centers.values():
        if c["n"]:
            for k in ("pca", "umap"):
                c[k] = [v / c["n"] for v in c[k]]
            c["d"] = c["dsum"] / c["n"]
        else:
            c["d"] = 0.0

    out = []
    for w in text.split()[:32]:
        # 用词的哈希稳定地落到某个聚类，jitter 一下
        cid = int(hashlib.md5(w.encode()).hexdigest(), 16) % K
        c = centers[cid]
        jit = lambda base, s: [base[j] + ((int(hashlib.md5((w+str(j)).encode()).hexdigest(),16)%1000)/1000-0.5)*s for j in range(3)]
        out.append({
            "token": w,
            "pca": [round(v,2) for v in jit(c["pca"], 18)],
            "umap": [round(v,2) for v in jit(c["umap"], 6)],
            "distortion": round(c["d"], 3),
        })
    return out


# ---------- 路由 ----------
@app.route("/api/embed", methods=["POST"])
def api_embed():
    text = (request.get_json(silent=True) or {}).get("text", "").strip()
    if not text:
        return jsonify({"points": [], "mode": "empty"})
    if REAL:
        return jsonify({"points": embed_real(text), "mode": "real"})
    return jsonify({"points": embed_mock(text), "mode": "mock"})


@app.route("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.route("/<path:p>")
def static_files(p):
    return send_from_directory(WEB, p)


if __name__ == "__main__":
    REAL = try_load_real()
    mode = "real（真·现跑 GPT-2）" if REAL else "mock（合成，骨架演示用）"
    print(f"模式：{mode}")
    print("打开 http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
