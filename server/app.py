#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py —— 词义星海的本地后端：托管前端 + /api/locate。

/api/locate 是核心：给一句话，对句子里的每个词取 GPT-2 第 N 层的上下文向量，
用 export_semantic_galaxy.py 训练的同一投影器投进固定的语义星海，并查最近邻底图词。
同一个多义词在不同句子里取到的上下文向量不同，落点也不同，这就是一词多义的呈现。

两种模式（自动选择）：
  · real：加载 GPT-2 + projector.joblib，真的现跑取上下文向量。
  · mock：没有 ML 依赖时，把词散布到星海，纯粹让交互链路能跑通。

启动：
    pip install -r server/requirements.txt
    python server/app.py        # 浏览器开 http://127.0.0.1:5000
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
REAL = None   # 成功则是一个 dict，存模型与投影器


def try_load_real():
    bundle = os.path.join(DATA, "projector.joblib")
    if not os.path.exists(bundle):
        return None
    try:
        import numpy as np, joblib, torch
        from transformers import GPT2Model, GPT2TokenizerFast
        b = joblib.load(bundle)
        tok = GPT2TokenizerFast.from_pretrained(b["model"])
        if tok.pad_token is None:
            tok.pad_token = tok.eos_token
        model = GPT2Model.from_pretrained(b["model"]).eval()
        base_index = {w.lower(): i for i, w in enumerate(b["base_tokens"])}
        print(f"✓ real 模式：GPT-2 + 第 {b['layer']} 层投影器已加载，底图 {len(b['base_tokens'])} 词")
        return {"np": np, "torch": torch, "tok": tok, "model": model,
                "b": b, "base_index": base_index}
    except Exception as e:
        print(f"· real 模式不可用（{e.__class__.__name__}: {e}），回退 mock")
        return None


def _apply_norm(X, p):
    # 与 pipeline/metrics.apply_normalizer 等价，内联以免后端依赖 pipeline 路径
    np = REAL["np"]
    X = np.asarray(X, dtype=np.float32) - np.asarray(p["center"], dtype=np.float32)
    return (X / p["r"]) * p["scale"]


def _split_words(tok, ids_list):
    """按 GPT-2 词首 token（Ġ）把 token 序列切成词，返回 [(词, [token 下标])]。
    这样既能正确合并子词，又能处理一句话里重复出现的同一个词。"""
    raw = tok.convert_ids_to_tokens(ids_list)
    groups = []
    for i, rt in enumerate(raw):
        if i == 0 or rt.startswith("Ġ"):
            groups.append([i])
        else:
            groups[-1].append(i)
    return [(tok.decode([ids_list[j] for j in g]).strip(), g) for g in groups]


def locate_real(text):
    np = REAL["np"]; torch = REAL["torch"]; tok = REAL["tok"]; model = REAL["model"]; b = REAL["b"]
    layer = b["layer"]; nn = b["nn"]; base_tokens = b["base_tokens"]
    enc = tok(text, return_tensors="pt", truncation=True, max_length=64)
    ids_list = enc["input_ids"][0].tolist()
    if not ids_list:
        return []
    with torch.no_grad():
        hs = model(**enc, output_hidden_states=True).hidden_states[layer][0]   # (seq, 768)
    out = []
    for w, idxs in _split_words(tok, ids_list):
        if not any(ch.isalpha() for ch in w):          # 跳过纯标点
            continue
        v = hs[idxs].mean(dim=0).cpu().numpy().astype(np.float32)
        v = (v / (np.linalg.norm(v) + 1e-8)).reshape(1, -1)
        xyz = _apply_norm(b["pca"].transform(v), b["pca_norm"])[0]
        uvw = _apply_norm(b["umap"].transform(v), b["umap_norm"])[0]
        _, idx = nn.kneighbors(v, n_neighbors=8)
        neighbors = [base_tokens[i] for i in idx[0] if base_tokens[i].lower() != w.lower()][:6]
        out.append({
            "word": w,
            "pca": [round(float(t), 2) for t in xyz],
            "umap": [round(float(t), 2) for t in uvw],
            "neighbors": neighbors,
        })
    return out


# ---------- mock 模式（无 ML 依赖时占位，保交互链路可跑）----------
_MOCK = None


def _mock_base():
    global _MOCK
    if _MOCK is None:
        for name in ("galaxy.json", "galaxy.sample.json"):
            p = os.path.join(DATA, name)
            if os.path.exists(p):
                with open(p, encoding="utf-8") as f:
                    _MOCK = json.load(f)
                break
    return _MOCK


def locate_mock(text):
    g = _mock_base()
    if not g:
        return []
    pts = g.get("umap") or g.get("pca")
    toks = g["tokens"]
    out = []
    for w in text.split()[:40]:
        if not any(ch.isalpha() for ch in w):
            continue
        i = int(hashlib.md5(w.encode()).hexdigest(), 16) % len(pts)
        out.append({"word": w.strip(), "pca": pts[i], "umap": pts[i], "neighbors": [toks[i]]})
    return out


# ---------- 路由 ----------
@app.route("/api/locate", methods=["POST"])
def api_locate():
    text = (request.get_json(silent=True) or {}).get("text", "").strip()
    if not text:
        return jsonify({"words": [], "mode": "empty"})
    if REAL:
        try:
            return jsonify({"words": locate_real(text), "mode": "real"})
        except Exception as e:
            import traceback; traceback.print_exc()
            return jsonify({"error": str(e)}), 500
    return jsonify({"words": locate_mock(text), "mode": "mock"})


@app.route("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.route("/<path:p>")
def static_files(p):
    return send_from_directory(WEB, p)


if __name__ == "__main__":
    REAL = try_load_real()
    print(f"模式：{'real（现跑 GPT-2 取上下文向量）' if REAL else 'mock（无 ML 依赖，散点占位）'}")
    print("打开 http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
