#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
export_code_galaxy.py —— 代码词义星海的构建期管线（ECNU bge 版）。

不再用本地 CodeBERT，改用 ECNU 平台的 bge embedding（ecnu-embedding-small / BGE-M3, 1024 维）。
做法：每个「代码符号用法」是一段聚焦该符号的代码片段，bge 把它编码成一个向量。
同一个多义符号在不同上下文片段里得到不同向量，于是散成不同的簇 —— 这就是代码一词多义。

注意：embedding API 只给整段一个向量，没有 token 级或逐层，所以不做「逐层可分度」。
义项落点、最近邻、义项轴仍然可做。

跑法：
    python pipeline/export_code_galaxy.py
（读 server/secrets.json 的 base_url / api_key / embedding_model；本地只做降维，无需 torch）
"""

import os, json, argparse, sys
import numpy as np
import colorsys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from metrics import normalize_layout, apply_normalizer

HERE = os.path.dirname(os.path.abspath(__file__))

# 精选代码多义符号案例：符号 → 义项 → 聚焦该义项的代码片段。
CASES = {
    "key": {
        "字典键 dict": ["value = config[key]", "for key in mapping.keys(): visit(key)", "result = cache[key]"],
        "加密密钥 crypto": ["ciphertext = aes.encrypt(data, key)", "private_key = load_pem(path)", "aes_key = derive_key(password, salt)"],
    },
    "token": {
        "认证令牌 auth": ["headers['Authorization'] = 'Bearer ' + token", "if token.expired: refresh_session()", "verify the access token signature"],
        "词法单元 lexer": ["for token in lexer.scan(source): emit(token)", "the parser reads the next token", "if token.kind == IDENTIFIER: bind(token)"],
    },
    "class": {
        "类 oop": ["class User(Base): id = Column(Integer)", "obj = PaymentService(); obj.charge(amount)", "the class inherits from Animal"],
        "样式类 css": ["element.classList.add(active_class)", "set the css class to highlight", "render a div with class container"],
    },
    "port": {
        "端口 net": ["server.listen(port=8080)", "socket.connect((host, port))", "the tcp port is already open"],
        "移植 verb": ["port the driver to windows", "porting the library to arm64", "the code was ported from c++"],
    },
    "stream": {
        "数据流 io": ["n = input_stream.readinto(buffer)", "write the bytes to the output stream", "close the file stream when done"],
        "视频流 video": ["start the live video stream", "the server pushes frames to the media stream", "buffer the streaming playback"],
    },
    "pool": {
        "连接池 conn": ["conn = db_pool.acquire()", "the connection pool is exhausted", "db_pool.release(conn)"],
        "线程池 thread": ["pool = ThreadPool(8); pool.submit(task)", "submit the job to the thread pool", "the worker pool size is 16"],
    },
}

# 单义背景片段，给星海铺出多领域的语义分区（标签 = 该片段聚焦的符号）。
EXTRA = [
    ("request", "request = http.get(url); body = request.json"),
    ("response", "response.status_code = 200; response.send(body)"),
    ("route", "router.route('/users', handler)"),
    ("middleware", "app.use(auth_middleware)"),
    ("array", "array = [1, 2, 3]; array.append(x)"),
    ("buffer", "buffer = bytearray(1024); fill(buffer)"),
    ("json", "data = json.loads(payload)"),
    ("tensor", "tensor = torch.randn(batch, dim)"),
    ("model", "logits = model.forward(tensor)"),
    ("gradient", "gradient = loss.backward()"),
    ("optimizer", "optimizer.step(); optimizer.zero_grad()"),
    ("weight", "weight = layer.weight.data"),
    ("query", "rows = db.query('SELECT * FROM users')"),
    ("cursor", "cursor = conn.cursor(); cursor.execute(sql)"),
    ("transaction", "transaction.commit()"),
    ("schema", "schema = Table('users', columns)"),
    ("hash", "digest = sha256(data).hexdigest()"),
    ("cipher", "cipher = AES.new(key, mode)"),
    ("signature", "signature = sign(message, private_key)"),
    ("nonce", "nonce = os.urandom(12)"),
    ("parser", "ast = parser.parse(source)"),
    ("ast", "node = ast.body[0]; visit(node)"),
    ("visitor", "visitor.visit(node)"),
    ("grammar", "grammar.add_rule(symbol, production)"),
    ("render", "component.render(); update_dom()"),
    ("element", "element = document.querySelector('#root')"),
    ("style", "element.style.color = 'red'"),
    ("event", "event.preventDefault(); dispatch(event)"),
    ("thread", "thread = Thread(target=worker); thread.start()"),
    ("mutex", "mutex.lock(); critical_section(); mutex.unlock()"),
    ("queue", "queue.put(item); job = queue.get()"),
    ("future", "future = executor.submit(task); future.result()"),
    ("socket", "socket.connect((host, 80)); socket.send(packet)"),
    ("packet", "packet = build_packet(header, payload)"),
    ("header", "header = packet.header; size = header.length"),
    ("matrix", "matrix = np.zeros((n, m))"),
    ("vector", "vector = matrix @ weights"),
    ("graph", "graph = build_graph(nodes, edges)"),
    ("node", "node = graph.add_node(value)"),
    ("cache", "cache = LRUCache(capacity); cache.put(k, v)"),
    ("dictionary", "d = {}; d[name] = value"),
    ("mapping", "for k in mapping: process(mapping[k])"),
    ("lookup", "result = symbol_table.lookup(name)"),
    ("config", "config = load_config(); host = config['host']"),
    ("lexer", "lexer = Lexer(source); tok = lexer.advance()"),
    ("grammar", "grammar.add_production(rule)"),
    ("identifier", "if ch.isalpha(): read_identifier()"),
    ("jwt", "payload = jwt.decode(access_token, secret)"),
    ("credential", "credential = authenticate(username, password)"),
    ("frame", "frame = video_capture.read_frame()"),
    ("codec", "codec = decoder.select_codec(fmt)"),
    ("file", "file = open(path, 'rb'); read(file)"),
    ("reader", "reader = io.BufferedReader(raw_file)"),
    ("connection", "connection = db_pool.get_connection()"),
    ("worker", "worker = Worker(queue); worker.run()"),
]


def cluster_palette(k):
    return [list(colorsys.hsv_to_rgb(i / k, 0.55, 1.0)) for i in range(k)]


def load_secrets():
    with open(os.path.join(HERE, "..", "server", "secrets.json"), encoding="utf-8") as f:
        return json.load(f)


def embed_texts(texts, sec, batch=16):
    """调 ECNU bge embedding（标准库 urllib，免 requests 依赖），返回 (N, 1024) 已 L2 归一。"""
    import urllib.request
    url = sec["base_url"].rstrip("/") + "/embeddings"
    out = []
    for i in range(0, len(texts), batch):
        chunk = texts[i:i + batch]
        payload = json.dumps({"model": sec["embedding_model"], "input": chunk}).encode("utf-8")
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Authorization": "Bearer " + sec["api_key"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = sorted(json.loads(resp.read().decode("utf-8"))["data"], key=lambda x: x["index"])
        out.extend(d["embedding"] for d in data)
        print(f"  bge 编码 {min(i + batch, len(texts))}/{len(texts)}", end="\r")
    print()
    X = np.array(out, dtype=np.float32)
    return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clusters", type=int, default=10)
    ap.add_argument("--out", default=os.path.join(HERE, "..", "web", "data", "galaxy.json"))
    args = ap.parse_args()
    sec = load_secrets()
    print(f"用 ECNU embedding：{sec['embedding_model']}（base={sec['base_url']}）")

    # ---- 1. 底图语料：多义符号各义项片段 + 单义背景片段 ----
    labels, texts = [], []
    for w, senses in CASES.items():
        for exs in senses.values():
            for ex in exs:
                labels.append(w); texts.append(ex)
    for w, ex in EXTRA:
        labels.append(w); texts.append(ex)
    print(f"底图片段 {len(texts)} 条，bge 编码中 …")
    X = embed_texts(texts, sec)

    # ---- 2. PCA / UMAP / KMeans / 最近邻 ----
    from sklearn.decomposition import PCA
    from sklearn.cluster import KMeans
    from sklearn.neighbors import NearestNeighbors
    print("PCA / UMAP / KMeans …")
    pca_model = PCA(n_components=3, random_state=42).fit(X)
    pca3, pca_norm = normalize_layout(pca_model.transform(X))
    import umap
    k_nn = min(15, max(5, len(texts) // 8))
    umap_model = umap.UMAP(n_components=3, n_neighbors=k_nn, min_dist=0.15, metric="cosine", random_state=42).fit(X)
    umap3, umap_norm = normalize_layout(umap_model.embedding_)
    ncl = min(args.clusters, max(2, len(texts) // 8))
    cluster = KMeans(n_clusters=ncl, n_init=4, random_state=42).fit_predict(X)
    palette = cluster_palette(ncl)
    cl_name = {}
    for i, c in enumerate(cluster):
        cl_name.setdefault(c, labels[i])
    nn = NearestNeighbors(n_neighbors=min(8, len(texts)), metric="cosine").fit(X)

    # ---- 3. 案例：每义项片段均值向量 → 落点 + 最近邻 ----
    print("预算多义案例 …")
    cases = []
    for word, senses in CASES.items():
        entries, sense_vecs = [], []
        for sname, exs in senses.items():
            V = embed_texts(exs, sec)
            v = V.mean(axis=0); v = v / (np.linalg.norm(v) + 1e-8)
            sense_vecs.append(v)
            q = v.reshape(1, -1)
            xyz = apply_normalizer(pca_model.transform(q), pca_norm)[0]
            uvw = apply_normalizer(umap_model.transform(q), umap_norm)[0]
            _, nbi = nn.kneighbors(q, n_neighbors=min(8, len(texts)))
            nbs, seen = [], set()
            for idx in nbi[0]:
                t = labels[idx]
                if t.lower() != word.lower() and t.lower() not in seen:
                    seen.add(t.lower()); nbs.append(t)
                if len(nbs) >= 6:
                    break
            entries.append({"name": sname, "xyz": [round(float(t), 3) for t in xyz],
                            "uvw": [round(float(t), 3) for t in uvw], "example": exs[0], "neighbors": nbs})
        # 两义项的 bge 余弦可分度（一个数，没有逐层）
        sep = round(float(1.0 - sense_vecs[0] @ sense_vecs[1]), 3) if len(sense_vecs) == 2 else 0.0
        cases.append({"word": word, "senses": entries, "sep_value": sep})

    # ---- 4. 导出 ----
    data = {
        "meta": {"source": f"ecnu:{sec['embedding_model']}", "count": len(texts), "layer": None,
                 "clusters": [{"id": int(i), "name": cl_name.get(i, f"区{i}"), "color": palette[i]} for i in range(ncl)],
                 "cases": cases, "notes": "ECNU bge(BGE-M3) 片段向量；底图=代码符号用法片段"},
        "tokens": labels, "cluster": cluster.tolist(),
        "pca": [[round(float(v), 2) for v in p] for p in pca3],
        "umap": [[round(float(v), 2) for v in p] for p in umap3],
        "size": [round(0.6, 3)] * len(texts),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"✓ 导出 {len(texts)} 个片段 → {args.out}")

    import joblib
    bundle = os.path.join(os.path.dirname(os.path.abspath(args.out)), "projector.joblib")
    joblib.dump({"embedding_model": sec["embedding_model"], "pca": pca_model, "umap": umap_model,
                 "pca_norm": pca_norm, "umap_norm": umap_norm, "nn": nn, "base_tokens": labels,
                 "base_xyz": [[round(float(v), 3) for v in p] for p in pca3]}, bundle)
    print(f"✓ 保存投影器 → {bundle}")

    # ---- 5. 自测：案例两义项间距 + 最近邻 ----
    print("\n=== 自测：案例两义项 UMAP 间距 + bge 余弦可分度 ===")
    for c in cases:
        if len(c["senses"]) == 2:
            a = np.array(c["senses"][0]["uvw"]); b = np.array(c["senses"][1]["uvw"])
            print(f"  {c['word']:<7} UMAP间距 {np.linalg.norm(a - b):6.1f}   余弦可分度 {c['sep_value']:.3f}")
    print("\n案例最近邻抽查：")
    for c in cases:
        for s in c["senses"]:
            print(f"  {c['word']}/{s['name'].split()[0]:<10} -> {' '.join(s['neighbors'])}")


if __name__ == "__main__":
    main()
