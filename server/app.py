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

        # 词表近邻索引（用于 /api/generate 把输入词扩成"邻域星系"）：top VOCAB 个常见词的余弦近邻
        VOCAB = min(20000, wte.shape[0])
        wte_norm = wte[:VOCAB] / (np.linalg.norm(wte[:VOCAB], axis=1, keepdims=True) + 1e-8)
        vocab_nn = NearestNeighbors(n_neighbors=9, metric="cosine").fit(wte[:VOCAB])

        print("✓ real 模式：GPT-2 + 投影器 + 词表近邻索引已加载")
        return {"np": np, "tok": tok, "wte": wte, "b": b, "nn": nn, "dist_ref": dist_ref,
                "vocab_nn": vocab_nn, "vocab": VOCAB}
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


# ---------- /api/generate：用输入词 + 其高维邻域，重新生成一整套星系 ----------
def build_live_dataset(text):
    np = REAL["np"]; tok = REAL["tok"]; wte = REAL["wte"]; VOCAB = REAL["vocab"]
    import sys, colorsys
    sys.path.insert(0, os.path.join(HERE, "..", "pipeline"))
    from metrics import per_point_global_distortion, trustworthiness, global_fidelity, normalize_layout
    from sklearn.decomposition import PCA
    from sklearn.cluster import KMeans
    import umap as _umap

    ids = list(dict.fromkeys(tok.encode(text)))[:40]            # 去重、限 40 个查询词
    if not ids:
        return {"error": "输入无法编码"}
    qset = set(ids)
    Q = wte[np.asarray(ids)]
    Q = Q / (np.linalg.norm(Q, axis=1, keepdims=True) + 1e-8)
    _, nb = REAL["vocab_nn"].kneighbors(Q)                      # 每个查询词的高维近邻(索引=token id)
    for row in nb:
        for j in row[1:]:
            qset.add(int(j))
    ids_all = list(qset)
    if len(ids_all) < 240:                                      # 点太少 UMAP 没结构 → 补常见词上下文
        step = max(1, VOCAB // 300)
        for t in range(0, VOCAB, step):
            if t not in qset:
                ids_all.append(t)
            if len(ids_all) >= 280:
                break
    ids_all = ids_all[:700]
    n = len(ids_all)
    arr = np.asarray(ids_all)
    X = wte[arr].astype(np.float32)
    tokens = [tok.decode([int(t)]).strip() or "·" for t in ids_all]

    pca3 = PCA(n_components=3, random_state=42).fit_transform(X)
    kum = min(15, max(5, n // 8))
    umap3 = _umap.UMAP(n_components=3, n_neighbors=kum, min_dist=0.1, metric="cosine", random_state=42).fit_transform(X)
    pca3, _ = normalize_layout(pca3)
    umap3, _ = normalize_layout(umap3)

    distortion = per_point_global_distortion(X, umap3, n_ref=min(400, n))
    kk = min(15, n - 1)
    pca_trust = round(trustworthiness(X, pca3, k=kk), 3)
    umap_trust = round(trustworthiness(X, umap3, k=kk), 3)
    pca_global = round(global_fidelity(X, pca3, n_query=min(300, n)), 3)
    umap_global = round(global_fidelity(X, umap3, n_query=min(300, n)), 3)

    kc = min(8, max(2, n // 30))
    cl = KMeans(n_clusters=kc, n_init=4, random_state=42).fit_predict(X)
    palette = [list(colorsys.hsv_to_rgb(i / kc, 0.55, 1.0)) for i in range(kc)]

    rng = np.random.default_rng(7)
    Xn = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-8)
    nP = min(2000, n * n)
    li = rng.integers(0, n, nP); lj = rng.integers(0, n, nP)
    keep = li != lj; li, lj = li[keep], lj[keep]
    dh = 1.0 - (Xn[li] * Xn[lj]).sum(1); du = np.linalg.norm(umap3[li] - umap3[lj], axis=1)
    hN = (dh - dh.min()) / (np.ptp(dh) + 1e-8); uN = (du - du.min()) / (np.ptp(du) + 1e-8)
    mism = np.abs(hN - uN)
    order = np.argsort(-mism)[:min(300, len(li))]
    links = [[int(li[k]), int(lj[k])] for k in order]
    link_score = [round(float(mism[k]), 3) for k in order]

    si = rng.integers(0, n, min(500, n * 2)); sj = rng.integers(0, n, min(500, n * 2))
    dHi = 1.0 - (Xn[si] * Xn[sj]).sum(1); dP = np.linalg.norm(pca3[si] - pca3[sj], axis=1); dU = np.linalg.norm(umap3[si] - umap3[sj], axis=1)
    n01 = lambda a: (a - a.min()) / (np.ptp(a) + 1e-8)
    shepard = {"dHi": [round(float(v), 3) for v in n01(dHi)],
               "dPca": [round(float(v), 3) for v in n01(dP)],
               "dUmap": [round(float(v), 3) for v in n01(dU)]}

    size = [1.0 if int(t) in set(ids) else 0.45 for t in ids_all]   # 你的输入词大一点

    return {
        "meta": {"source": "live:" + text[:40], "count": n,
                 "clusters": [{"id": i, "name": "簇" + str(i), "color": palette[i]} for i in range(kc)],
                 "metrics": {"pca_trustworthiness": pca_trust, "umap_trustworthiness": umap_trust,
                             "pca_global": pca_global, "umap_global": umap_global},
                 "shepard": shepard,
                 "notes": "实时生成：输入词 + 其高维邻域，重新 PCA/UMAP；输入词已放大"},
        "tokens": tokens, "cluster": cl.tolist(),
        "pca": [[round(float(v), 2) for v in p] for p in pca3],
        "umap": [[round(float(v), 2) for v in p] for p in umap3],
        "distortion": [round(float(v), 3) for v in distortion],
        "size": size, "links": links, "link_score": link_score,
    }


# ---------- 路由 ----------
@app.route("/api/generate", methods=["POST"])
def api_generate():
    text = (request.get_json(silent=True) or {}).get("text", "").strip()
    if not text:
        return jsonify({"error": "empty"}), 400
    if not REAL:
        return jsonify({"error": "需要 real 模式：先 pip install -r pipeline/requirements.txt 并运行 export_embeddings.py 生成 projector.joblib"}), 503
    try:
        return jsonify(build_live_dataset(text))
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


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
