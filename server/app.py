#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py —— 代码符号语义探索器后端：托管前端 + /api/analyze（一次出齐联动所需的整份分析）。

/api/analyze(POST {code}) 做的事：
  1. 抽取代码里每个标识符的「每一次出现」(occurrence)，各取 ±2 行上下文窗口。
  2. 用 ECNU bge 把每个 occurrence 的「符号 + 窗口」编码成向量（同名符号的不同出现 → 不同向量）。
  3. 对本次所有 occurrence 当场 fit PCA / UMAP 到 3 维（不依赖任何预设底图、不持久化投影器）。
  4. 对出现 ≥2 次的「多义候选符号」，一次调 ecnu-max 判读每处的义项 / 依据 / 置信。
  5. 按义项归类着色、算 occurrence 内最近邻，组装成 galaxy 超集 JSON 返回。

凭据从 server/secrets.json 读（已 gitignore）。本地用 sklearn/umap 当场降维，无需 torch。
"""

import os, json, re, sys, urllib.request, colorsys
from collections import defaultdict
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

STOP = set("if else elif for while return def import from in and or not is None True False pass break "
           "continue with as try except finally lambda yield global del print self int str float bool "
           "len range list dict set tuple type new var let const function void public private static this "
           "null true false void".split())
IDENT = re.compile(r"[A-Za-z_]\w*")
SINGLE = "（单次出现）"


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
    try:
        import numpy as np
        import sklearn, umap  # noqa: F401  仅确认可用
        sec = load_secrets()
        if not sec.get("api_key") or not sec.get("base_url"):
            print("· 缺少 API 凭据（server/secrets.json），/api/analyze 不可用")
            return None
        print(f"✓ real 模式：当场 fit 投影 + ECNU（bge={sec.get('embedding_model')}, chat={sec.get('chat_model')}）")
        return {"np": np, "sec": sec}
    except Exception as e:
        print(f"· real 不可用（{e.__class__.__name__}: {e}）")
        return None


def _post(path, payload, timeout=60):
    sec = REAL["sec"]
    req = urllib.request.Request(sec["base_url"].rstrip("/") + path,
                                 data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers={"Authorization": "Bearer " + sec["api_key"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _embed(texts, batch=16):
    np = REAL["np"]
    out = []
    for i in range(0, len(texts), batch):
        data = sorted(_post("/embeddings", {"model": REAL["sec"]["embedding_model"], "input": texts[i:i + batch]})["data"],
                      key=lambda x: x["index"])
        out.extend(d["embedding"] for d in data)
    X = np.array(out, dtype=np.float32)
    return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-8)


def _norm_layout(P, scale=60.0):
    np = REAL["np"]
    P = np.asarray(P, dtype=np.float32)
    P = P - P.mean(0)
    r = float(np.percentile(np.linalg.norm(P, axis=1), 98)) or 1.0
    return (P / r) * scale


def agent_analyze(code, multi):
    """一次调 ecnu-max 判读所有多义候选符号的每处出现。返回 {(symbol,line): {sense,evidence,confidence}}。"""
    lines = code.split("\n")
    numbered = "\n".join(f"{i + 1}: {l}" for i, l in enumerate(lines))
    syms = "；".join(f'{s}(第 {",".join(str(o["line"]) for o in v)} 行)' for s, v in multi.items())
    prompt = (f"下面是带行号的代码。这些标识符各出现多次：{syms}。\n"
              f"对每个标识符的每一次出现，判断它在那一处的含义（义项，用简短中文词，如「字典键」「加密密钥」「线程池」），"
              f"给出依据行原文和置信(0~1)。\n\n代码：\n{numbered}\n\n"
              f"只输出 JSON，不要多余文字：{{\"items\":[{{\"symbol\":\"key\",\"line\":3,\"sense\":\"字典键\","
              f"\"evidence\":[\"value = config[key]\"],\"confidence\":0.9}}]}}")
    content = _post("/chat/completions",
                    {"model": REAL["sec"]["chat_model"], "messages": [{"role": "user", "content": prompt}]},
                    timeout=120)["choices"][0]["message"]["content"]
    m = re.search(r"\{.*\}", content, re.S)
    try:
        items = json.loads(m.group())["items"]
        return {(it["symbol"], int(it["line"])): it for it in items}
    except Exception:
        return {}


def analyze(code):
    np = REAL["np"]
    lines = code.split("\n")
    occs = []
    for li, line in enumerate(lines):
        for mt in IDENT.finditer(line):
            w = mt.group()
            if w in STOP or len(w) < 2 or w.isdigit():
                continue
            occs.append({"id": len(occs), "symbol": w, "line": li + 1, "col": mt.start(),
                         "context": line.strip(),
                         "window": "\n".join(lines[max(0, li - 2):li + 3])})
    if not occs:
        return {"error": "没有可分析的标识符"}

    X = _embed([f'{o["symbol"]} in:\n{o["window"]}' for o in occs])

    from sklearn.decomposition import PCA
    from sklearn.neighbors import NearestNeighbors
    pca3 = _norm_layout(PCA(n_components=3, random_state=42).fit_transform(X))
    if len(occs) >= 5:
        import umap
        nb = min(15, max(2, len(occs) // 4))
        umap3 = _norm_layout(umap.UMAP(n_components=3, n_neighbors=nb, min_dist=0.15,
                                       metric="cosine", random_state=42).fit_transform(X))
    else:
        umap3 = pca3.copy()
    nn = NearestNeighbors(n_neighbors=min(7, len(occs)), metric="cosine").fit(X)
    nbidx = nn.kneighbors(X, return_distance=False)

    bysym = defaultdict(list)
    for o in occs:
        bysym[o["symbol"]].append(o)
    multi = {s: v for s, v in bysym.items() if len(v) >= 2}
    senses = agent_analyze(code, multi) if multi else {}

    clusters, sid = [], {}
    def sense_id(name):
        if name not in sid:
            sid[name] = len(clusters)
            clusters.append({"id": len(clusters), "name": name})
        return sid[name]

    for o in occs:
        info = senses.get((o["symbol"], o["line"]))
        o["sense"] = info.get("sense", "?") if info else SINGLE
        o["evidence"] = info.get("evidence", []) if info else []
        o["confidence"] = info.get("confidence") if info else None
        o["senseId"] = sense_id(o["sense"])
        o["neighbors"] = [int(j) for j in nbidx[o["id"]] if int(j) != o["id"]][:6]

    K = max(1, len(clusters))
    for c in clusters:
        c["color"] = [0.5, 0.55, 0.66] if c["name"] == SINGLE else list(colorsys.hsv_to_rgb(c["id"] / K, 0.62, 1.0))

    return {
        "schema": "code-galaxy/v1",
        "meta": {"source": "ecnu:bge+ecnu-max", "code": code, "count": len(occs), "clusters": clusters,
                 "symbols": [{"name": s, "occ": [o["id"] for o in v], "multi": len(v) >= 2} for s, v in bysym.items()],
                 "notes": "occurrence 级 bge 向量；着色=ecnu-max 判出的义项"},
        "tokens": [o["symbol"] for o in occs],
        "cluster": [o["senseId"] for o in occs],
        "pca": [[round(float(v), 2) for v in p] for p in pca3],
        "umap": [[round(float(v), 2) for v in p] for p in umap3],
        "size": [0.6] * len(occs),
        "occ": [{"id": o["id"], "symbol": o["symbol"], "line": o["line"], "col": o["col"], "context": o["context"],
                 "senseId": o["senseId"], "sense": o["sense"], "evidence": o["evidence"],
                 "confidence": o["confidence"], "neighbors": o["neighbors"]} for o in occs],
    }


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    code = (request.get_json(silent=True) or {}).get("code", "").strip()
    if not code:
        return jsonify({"error": "empty"}), 400
    if not REAL:
        return jsonify({"error": "需要 ECNU 凭据：在 server/secrets.json 配置 base_url/api_key"}), 503
    try:
        return jsonify(analyze(code))
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
    print(f"模式：{'real（/api/analyze 可用）' if REAL else 'mock（缺凭据/依赖，仅能导入星海数据离线演示）'}")
    print("打开 http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
