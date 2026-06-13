#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py —— 代码词义星海后端：托管前端 + /api/locate（bge 投影）+ /api/agent（ecnu-max 判读）。

embedding 用 ECNU bge（ecnu-embedding-small），agent 判读用 ecnu-max，都走 ECNU 的 OpenAI 兼容 API。
凭据从 server/secrets.json 读（已 gitignore）。本地只做降维投影（投影器在 projector.joblib），无需 torch。

启动：
    python server/app.py        # 浏览器开 http://127.0.0.1:5000
"""

import os, json, re, sys, urllib.request
from flask import Flask, request, jsonify, send_from_directory

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "web")
DATA = os.path.join(WEB, "data")

app = Flask(__name__, static_folder=None)
REAL = None

# 抽代码标识符时跳过控制流关键字（class 保留，它是多义案例符号）。
STOP = set("if else elif for while return def import from in and or not is None True False "
           "pass break continue with as try except finally lambda yield global del print self".split())
IDENT = re.compile(r"[A-Za-z_]\w*")


def load_secrets():
    p = os.path.join(HERE, "secrets.json")
    if not os.path.exists(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def try_load_real():
    bundle = os.path.join(DATA, "projector.joblib")
    if not os.path.exists(bundle):
        return None
    try:
        import joblib, numpy as np
        sec = load_secrets()
        if not sec.get("api_key") or not sec.get("base_url"):
            print("· 缺少 API 凭据（server/secrets.json），回退 mock")
            return None
        b = joblib.load(bundle)
        print(f"✓ real 模式：bge 投影器已加载（底图 {len(b['base_tokens'])} 片段，embedding={sec.get('embedding_model')}）")
        return {"np": np, "b": b, "sec": sec}
    except Exception as e:
        print(f"· real 模式不可用（{e.__class__.__name__}: {e}），回退 mock")
        return None


def _post(path, payload, timeout=60):
    sec = REAL["sec"]
    url = sec["base_url"].rstrip("/") + path
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers={"Authorization": "Bearer " + sec["api_key"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _embed(texts):
    np = REAL["np"]
    data = sorted(_post("/embeddings", {"model": REAL["sec"]["embedding_model"], "input": texts})["data"],
                  key=lambda x: x["index"])
    X = np.array([d["embedding"] for d in data], dtype=np.float32)
    return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-8)


def _apply_norm(X, p):
    np = REAL["np"]
    X = np.asarray(X, dtype=np.float32) - np.asarray(p["center"], dtype=np.float32)
    return (X / p["r"]) * p["scale"]


def locate_real(text):
    """输入一段代码：抽每个标识符，用它所在的行做 bge 向量，投到星海并查最近邻。"""
    b = REAL["b"]
    items = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        for m in IDENT.finditer(line):
            w = m.group()
            if w in STOP or len(w) < 2 or w.isdigit():
                continue
            items.append((w, line))
    if not items:
        return []
    uniq = list(dict.fromkeys(l for _, l in items))
    vecs = _embed(uniq)
    line2vec = {l: vecs[i] for i, l in enumerate(uniq)}
    out, seen = [], set()
    for w, line in items:
        if (w, line) in seen:
            continue
        seen.add((w, line))
        v = line2vec[line].reshape(1, -1)
        xyz = _apply_norm(b["pca"].transform(v), b["pca_norm"])[0]
        uvw = _apply_norm(b["umap"].transform(v), b["umap_norm"])[0]
        _, idx = b["nn"].kneighbors(v, n_neighbors=min(8, len(b["base_tokens"])))
        nbs, s2 = [], set()
        for i in idx[0]:
            t = b["base_tokens"][i]
            if t.lower() != w.lower() and t.lower() not in s2:
                s2.add(t.lower()); nbs.append(t)
            if len(nbs) >= 6:
                break
        out.append({"word": w, "pca": [round(float(t), 2) for t in xyz],
                    "umap": [round(float(t), 2) for t in uvw], "neighbors": nbs})
    return out


def agent_judge(code, symbol):
    """让 ecnu-max 判读符号在代码里的含义，并指出依据的代码行。"""
    prompt = (f"下面是一段代码。判断标识符 `{symbol}` 在这段代码里的含义（属于哪种用法/义项），"
              f"并指出你依据了哪些行。\n\n代码：\n{code}\n\n"
              f"只输出 JSON，不要多余文字：{{\"sense\": \"一句话说明该符号此处的含义\", "
              f"\"evidence\": [\"作为依据的代码行原文\"], \"confidence\": 0到1之间的数}}")
    content = _post("/chat/completions",
                    {"model": REAL["sec"]["chat_model"], "messages": [{"role": "user", "content": prompt}]},
                    timeout=90)["choices"][0]["message"]["content"]
    m = re.search(r"\{.*\}", content, re.S)   # 容错：可能裹在 markdown 里
    try:
        return json.loads(m.group() if m else content)
    except Exception:
        return {"sense": content.strip()[:300], "evidence": [], "confidence": None}


# ---------- mock（无凭据/投影器时占位）----------
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
    import hashlib
    g = _mock_base()
    if not g:
        return []
    pts = g.get("umap") or g.get("pca")
    out = []
    for w in set(re.findall(r"[A-Za-z_]\w+", text)):
        if w in STOP or len(w) < 2:
            continue
        i = int(hashlib.md5(w.encode()).hexdigest(), 16) % len(pts)
        out.append({"word": w, "pca": pts[i], "umap": pts[i], "neighbors": [g["tokens"][i]]})
    return out[:40]


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


@app.route("/api/agent", methods=["POST"])
def api_agent():
    body = request.get_json(silent=True) or {}
    code = (body.get("text") or "").strip()
    symbol = (body.get("symbol") or "").strip()
    if not code or not symbol:
        return jsonify({"error": "需要 text(代码) 和 symbol(目标符号)"}), 400
    if not REAL:
        return jsonify({"error": "需要 API 凭据：在 server/secrets.json 配置 ECNU base_url/api_key"}), 503
    try:
        return jsonify({"result": agent_judge(code, symbol), "mode": "real"})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.route("/<path:p>")
def static_files(p):
    return send_from_directory(WEB, p)


if __name__ == "__main__":
    REAL = try_load_real()
    print(f"模式：{'real（ECNU bge + ecnu-max）' if REAL else 'mock（缺凭据/投影器，散点占位）'}")
    print("打开 http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
