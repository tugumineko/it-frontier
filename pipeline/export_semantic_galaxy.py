#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
export_semantic_galaxy.py —— 词义星海的构建期管线。

和旧的 export_embeddings.py 的根本区别：取的是 GPT-2 的「上下文向量」，
不是静态词嵌入。诊断脚本已确认第 9 层对一词多义最可分（判别准确率 0.90）。

它做的事：
  1. 取一批常见词，每个词放进一个中性模板句，跑 GPT-2 取第 9 层向量，
     作为这个词在「无强上下文」时的默认语义位置。这批点就是语义星海底图。
  2. 在这些第 9 层向量上做 PCA / UMAP 到 3D、KMeans 上色、建最近邻索引。
  3. 一组精选多义词，每个义项用若干例句取第 9 层向量求平均，投到同一空间，
     得到各义项簇的落点，存进 meta.cases，供前端高亮对比。
  4. 导出 galaxy.json（底图）+ projector.joblib（投影器、最近邻、第 9 层底图向量），
     后端 /api/locate 用它把任意句子里的词投到同一片星海。

跑法：
    python pipeline/export_semantic_galaxy.py --topk 1500 --layer 9
"""

import os, json, argparse, sys, re
import numpy as np
import colorsys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from metrics import normalize_layout, apply_normalizer

TEMPLATE = "The {w} is here."

# 精选多义词案例：每个词两个义项，每义项若干例句（已被诊断验证可分）。
CASES = {
    "bank": {
        "金融 finance": [
            "I deposited money in the bank yesterday.",
            "The bank approved my mortgage loan.",
            "The central bank raised interest rates again.",
        ],
        "河岸 river": [
            "We sat on the grassy bank of the river.",
            "The boat drifted toward the muddy bank.",
            "Wild flowers grew along the river bank.",
        ],
    },
    "apple": {
        "公司 company": [
            "Apple released a new iPhone this fall.",
            "I bought some Apple stock last year.",
            "Apple is a giant technology company.",
        ],
        "水果 fruit": [
            "I ate a crunchy red apple for lunch.",
            "The apple fell from the old tree.",
            "She poured a glass of fresh apple juice.",
        ],
    },
    "spring": {
        "季节 season": [
            "The cherry flowers bloom every spring.",
            "Spring is the warmest part of the year here.",
            "We planted seeds in early spring.",
        ],
        "弹簧 coil": [
            "The metal spring in the clock snapped.",
            "He compressed the steel spring with his hand.",
            "A loose spring popped out of the sofa.",
        ],
    },
    "bat": {
        "蝙蝠 animal": [
            "A bat flew out of the dark cave.",
            "Bats are nocturnal flying mammals.",
            "The bat hung upside down from the branch.",
        ],
        "球棒 baseball": [
            "He swung the wooden baseball bat hard.",
            "She gripped the bat and waited for the pitch.",
            "The player cracked the ball with his bat.",
        ],
    },
    "light": {
        "光 illumination": [
            "Please turn on the light in the hallway.",
            "The morning light streamed through the window.",
            "A bright light flashed in the distance.",
        ],
        "轻 weight": [
            "This backpack is surprisingly light to carry.",
            "She prefers a light meal in the evening.",
            "The feather is extremely light.",
        ],
    },
}


def cluster_palette(k):
    return [list(colorsys.hsv_to_rgb(i / k, 0.55, 1.0)) for i in range(k)]


def find_token_indices(offsets, span):
    a, b = span
    idx = []
    for i, (s, e) in enumerate(offsets):
        if s == e:
            continue
        if s < b and e > a:
            idx.append(i)
    return idx


def word_span(sentence, word):
    p = sentence.lower().find(word.lower())
    return None if p < 0 else (p, p + len(word))


class Embedder:
    """把「句子 + 目标词」批量编码成第 layer 层的上下文向量。"""

    def __init__(self, model_name, layer):
        import torch
        from transformers import GPT2Model, GPT2TokenizerFast
        self.torch = torch
        self.tok = GPT2TokenizerFast.from_pretrained(model_name)
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        self.model = GPT2Model.from_pretrained(model_name).eval()
        self.layer = layer

    def encode(self, sentences, words, batch=32):
        torch = self.torch
        out = np.zeros((len(sentences), self.model.config.n_embd), dtype=np.float32)
        for b0 in range(0, len(sentences), batch):
            chunk_s = sentences[b0:b0 + batch]
            chunk_w = words[b0:b0 + batch]
            enc = self.tok(chunk_s, return_offsets_mapping=True, return_tensors="pt",
                           padding=True, truncation=True, max_length=32)
            offs = enc.pop("offset_mapping").tolist()
            with torch.no_grad():
                hs = self.model(**enc, output_hidden_states=True).hidden_states[self.layer]
            for i, (sent, w) in enumerate(zip(chunk_s, chunk_w)):
                span = word_span(sent, w)
                tids = find_token_indices(offs[i], span) if span else []
                if not tids:
                    tids = [t for t, (s, e) in enumerate(offs[i]) if s != e]  # 兜底：全句平均
                out[b0 + i] = hs[i][tids].mean(dim=0).cpu().numpy()
            print(f"  编码 {min(b0 + batch, len(sentences))}/{len(sentences)}", end="\r")
        print()
        out = out / (np.linalg.norm(out, axis=1, keepdims=True) + 1e-8)  # L2 归一，压住 GPT-2 的 outlier 维度
        return out

    def encode_all_layers(self, sentences, words, batch=32):
        """取每个词在所有层(0..n)的上下文向量，返回 (n_layers, M, 768)，逐层 L2 归一。用于逐层轨迹。"""
        torch = self.torch
        n_layers = self.model.config.n_layer + 1
        out = np.zeros((n_layers, len(sentences), self.model.config.n_embd), dtype=np.float32)
        for b0 in range(0, len(sentences), batch):
            cs, cw = sentences[b0:b0 + batch], words[b0:b0 + batch]
            enc = self.tok(cs, return_offsets_mapping=True, return_tensors="pt",
                           padding=True, truncation=True, max_length=32)
            offs = enc.pop("offset_mapping").tolist()
            with torch.no_grad():
                hs_all = self.model(**enc, output_hidden_states=True).hidden_states
            for i, (sent, w) in enumerate(zip(cs, cw)):
                span = word_span(sent, w)
                tids = find_token_indices(offs[i], span) if span else []
                if not tids:
                    tids = [t for t, (s, e) in enumerate(offs[i]) if s != e]
                for L in range(n_layers):
                    out[L, b0 + i] = hs_all[L][i][tids].mean(dim=0).cpu().numpy()
        return out / (np.linalg.norm(out, axis=2, keepdims=True) + 1e-8)


def pick_vocab(tok, topk):
    """挑前 topk 个干净完整英文词。GPT-2 的 BPE 里词首 token 带前导空格（Ġ），
    无 Ġ 的是子词碎片（ing、er…），要排除，否则星海全是碎片不是词。"""
    words, seen = [], set()
    vid = 0
    while len(words) < topk and vid < tok.vocab_size:
        cur = vid
        vid += 1
        raw = tok.convert_ids_to_tokens(cur)
        if not raw or not raw.startswith("Ġ"):    # 只取词首（Ġ）
            continue
        w = tok.decode([cur]).strip()
        if not (w.isascii() and w.isalpha() and 2 <= len(w) <= 14):
            continue
        key = w.lower()
        if key in seen:
            continue
        seen.add(key)
        words.append(w)
    return words


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.join(here, "..", "web", "data", "galaxy.json")
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gpt2")
    ap.add_argument("--topk", type=int, default=1500, help="语义星海底图词数")
    ap.add_argument("--layer", type=int, default=9, help="取第几层上下文向量")
    ap.add_argument("--clusters", type=int, default=12)
    ap.add_argument("--knn", type=int, default=15)
    ap.add_argument("--out", default=default_out)
    args = ap.parse_args()

    print(f"加载 {args.model}，取第 {args.layer} 层上下文向量 …")
    emb = Embedder(args.model, args.layer)

    # ---- 1. 底图词 + 第 9 层向量（模板句）----
    tokens = pick_vocab(emb.tok, args.topk)
    print(f"底图词 {len(tokens)} 个，编码中 …")
    sents = [TEMPLATE.format(w=w) for w in tokens]
    X = emb.encode(sents, tokens)                       # (N, 768)

    # ---- 2. PCA / UMAP / KMeans / 最近邻索引 ----
    from sklearn.decomposition import PCA
    from sklearn.cluster import KMeans
    from sklearn.neighbors import NearestNeighbors
    print("PCA → 3D …")
    pca_model = PCA(n_components=3, random_state=42).fit(X)
    pca3, pca_norm = normalize_layout(pca_model.transform(X))
    print("UMAP → 3D …")
    import umap
    umap_model = umap.UMAP(n_components=3, n_neighbors=args.knn, min_dist=0.15,
                           metric="cosine", random_state=42).fit(X)
    umap3, umap_norm = normalize_layout(umap_model.embedding_)
    print("KMeans 上色 …")
    km = KMeans(n_clusters=args.clusters, n_init=4, random_state=42).fit(X)
    cluster = km.labels_.astype(int)
    palette = cluster_palette(args.clusters)
    # 簇名 = 簇内最常见（id 最靠前）的词
    cl_name = {}
    for i, c in enumerate(cluster):
        if c not in cl_name:
            cl_name[c] = tokens[i]
    nn = NearestNeighbors(n_neighbors=8, metric="cosine").fit(X)

    # ---- 3. 多义词案例：每义项例句 → 第 9 层均值 → 投影 ----
    print("预算多义词案例：义项落点 + 最近邻 + 逐层轨迹 + 可分度曲线 …")
    cases = []
    for word, senses in CASES.items():
        sense_entries = []
        layer_centers = []                                          # [义项][层] = 归一化高维中心
        for sname, exs in senses.items():
            AL = emb.encode_all_layers(exs, [word] * len(exs))      # (n_layers, M, 768)
            centers = [AL[L].mean(axis=0) / (np.linalg.norm(AL[L].mean(axis=0)) + 1e-8)
                       for L in range(AL.shape[0])]
            layer_centers.append(centers)
            v9 = centers[args.layer].reshape(1, -1)
            xyz = apply_normalizer(pca_model.transform(v9), pca_norm)[0]
            uvw = apply_normalizer(umap_model.transform(v9), umap_norm)[0]
            _, nbi = nn.kneighbors(v9, n_neighbors=8)               # C：义项的最近邻底图词
            neighbors = [tokens[i] for i in nbi[0] if tokens[i].lower() != word.lower()][:6]
            # A：各层落点用 PCA 线性投影（对各层稳定；A 动画切到 PCA 底图）
            traj = [[round(float(t), 2) for t in apply_normalizer(pca_model.transform(c.reshape(1, -1)), pca_norm)[0]]
                    for c in centers]
            sense_entries.append({
                "name": sname,
                "xyz": [round(float(t), 3) for t in xyz],
                "uvw": [round(float(t), 3) for t in uvw],
                "example": exs[0], "neighbors": neighbors, "traj": traj,
            })
        # A 的科学证据：两义项高维中心的逐层余弦可分度（不依赖投影，最准）
        sep = []
        if len(layer_centers) == 2:
            sep = [round(float(1.0 - layer_centers[0][L] @ layer_centers[1][L]), 3)
                   for L in range(len(layer_centers[0]))]
        cases.append({"word": word, "senses": sense_entries, "sep": sep})

    size = (1.0 - np.arange(len(tokens)) / len(tokens)).astype(np.float32)

    # ---- 4. 导出底图 ----
    data = {
        "meta": {
            "source": f"gpt2:layer{args.layer}",
            "count": len(tokens),
            "layer": args.layer,
            "clusters": [{"id": int(i), "name": cl_name.get(i, f"簇{i}"),
                          "color": palette[i]} for i in range(args.clusters)],
            "cases": cases,
            "notes": f"GPT-2 第 {args.layer} 层上下文向量；底图为模板句中各词的默认语义位置",
        },
        "tokens": tokens,
        "cluster": cluster.tolist(),
        "pca": [[round(float(v), 2) for v in p] for p in pca3],
        "umap": [[round(float(v), 2) for v in p] for p in umap3],
        "size": [round(float(v), 3) for v in size],
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"✓ 导出底图 {len(tokens)} 词 → {args.out}")

    # ---- 5. 投影器 bundle（后端 /api/locate 用）----
    import joblib
    bundle = os.path.join(os.path.dirname(os.path.abspath(args.out)), "projector.joblib")
    joblib.dump({
        "model": args.model, "layer": args.layer,
        "pca": pca_model, "umap": umap_model,
        "pca_norm": pca_norm, "umap_norm": umap_norm,
        "nn": nn, "base_tokens": tokens,
        "base_xyz": [[round(float(v), 3) for v in p] for p in pca3],
    }, bundle)
    print(f"✓ 保存投影器 → {bundle}")

    # ---- 6. 自测：案例两义项逐层间距曲线（峰值应在中间层，呼应判别率曲线）----
    print(f"\n底图坐标范围 PCA [{pca3.min():.0f}, {pca3.max():.0f}]  UMAP [{umap3.min():.0f}, {umap3.max():.0f}]")
    print("=== 自测：案例两义项逐层可分度(余弦距离)，峰值层应落在中间层 ===")
    for c in cases:
        if c.get("sep"):
            d = np.array(c["sep"]); peak = int(np.argmax(d))
            print(f"  {c['word']:<7} 峰值层 {peak:>2}  可分度 L0={d[0]:.3f}  L{peak}={d[peak]:.3f}  L12={d[-1]:.3f}")


if __name__ == "__main__":
    main()
