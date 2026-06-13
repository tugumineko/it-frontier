#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diagnose_polysemy.py —— 验证"词义星海"方向的技术前提是否成立。

核心假设：把整句话喂进 GPT-2，取目标词在某一中间层的上下文向量（contextual
embedding），同一个多义词的不同义项会分到不同位置。若不成立，这个方向就垮了。

做法：
  - 一组多义词，每词两个义项，每义项若干例句。
  - 逐句跑 GPT-2，定位目标词的 token，取每一层的 hidden state。
  - 逐层评估义项可分度：留一法 1-NN（余弦）判别义项的准确率，以及
    类内 / 类间平均余弦相似度的差距。
  - 扫所有层，找哪层分得最开。静态词嵌入（第 0 层附近）应当分不开，
    中间层应当明显可分。

这步只在构建期跑一次，用来选层、确认方向，不进演示。
"""

import sys
import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# (目标词, 义项标签, 例句)
SAMPLES = [
    ("bank", "finance", "I deposited money in the bank yesterday."),
    ("bank", "finance", "The bank approved my mortgage loan."),
    ("bank", "finance", "She works as a teller at a commercial bank."),
    ("bank", "finance", "The central bank raised interest rates again."),
    ("bank", "river", "We sat on the grassy bank of the river."),
    ("bank", "river", "The boat drifted toward the muddy bank."),
    ("bank", "river", "Wild flowers grew along the river bank."),
    ("bank", "river", "He climbed up the steep bank to the road."),

    ("apple", "company", "Apple released a new iPhone this fall."),
    ("apple", "company", "I bought some Apple stock last year."),
    ("apple", "company", "Apple is a giant technology company."),
    ("apple", "fruit", "I ate a crunchy red apple for lunch."),
    ("apple", "fruit", "The apple fell from the old tree."),
    ("apple", "fruit", "She poured a glass of fresh apple juice."),

    ("spring", "season", "The cherry flowers bloom every spring."),
    ("spring", "season", "Spring is the warmest part of the year here."),
    ("spring", "season", "We planted seeds in early spring."),
    ("spring", "coil", "The metal spring in the clock snapped."),
    ("spring", "coil", "He compressed the steel spring with his hand."),
    ("spring", "coil", "A loose spring popped out of the sofa."),

    ("bat", "animal", "A bat flew out of the dark cave."),
    ("bat", "animal", "Bats are nocturnal flying mammals."),
    ("bat", "animal", "The bat hung upside down from the branch."),
    ("bat", "baseball", "He swung the wooden baseball bat hard."),
    ("bat", "baseball", "She gripped the bat and waited for the pitch."),
    ("bat", "baseball", "The player cracked the ball with his bat."),

    ("light", "illumination", "Please turn on the light in the hallway."),
    ("light", "illumination", "The morning light streamed through the window."),
    ("light", "illumination", "A bright light flashed in the distance."),
    ("light", "weight", "This backpack is surprisingly light to carry."),
    ("light", "weight", "She prefers a light meal in the evening."),
    ("light", "weight", "The feather is extremely light."),
]


def find_token_indices(offsets, span):
    """返回 char span [a,b) 内有重叠的 token 下标列表。"""
    a, b = span
    idx = []
    for i, (s, e) in enumerate(offsets):
        if s == e:           # 特殊 token
            continue
        if s < b and e > a:  # 区间重叠
            idx.append(i)
    return idx


def word_span(sentence, word):
    low = sentence.lower()
    p = low.find(word.lower())
    if p < 0:
        return None
    return (p, p + len(word))


def cos_sim_matrix(V):
    Vn = V / (np.linalg.norm(V, axis=1, keepdims=True) + 1e-8)
    return Vn @ Vn.T


def eval_layer(vecs, words, senses):
    """逐词评估：留一法 1-NN 义项判别准确率 + 类内类间相似度差。"""
    acc_list, gap_list = [], []
    for w in sorted(set(words)):
        idx = [i for i in range(len(words)) if words[i] == w]
        V = vecs[idx]
        S = [senses[i] for i in idx]
        sim = cos_sim_matrix(V)
        np.fill_diagonal(sim, -2.0)
        # 留一法 1-NN
        hit = 0
        for i in range(len(idx)):
            j = int(np.argmax(sim[i]))
            if S[j] == S[i]:
                hit += 1
        acc_list.append(hit / len(idx))
        # 类内 / 类间平均相似度
        intra, inter = [], []
        for i in range(len(idx)):
            for j in range(i + 1, len(idx)):
                (intra if S[i] == S[j] else inter).append(sim[i, j])
        gap_list.append(np.mean(intra) - np.mean(inter))
    return float(np.mean(acc_list)), float(np.mean(gap_list))


def main():
    import torch
    from transformers import GPT2Model, GPT2TokenizerFast

    print("加载 gpt2 …")
    tok = GPT2TokenizerFast.from_pretrained("gpt2")
    model = GPT2Model.from_pretrained("gpt2").eval()

    n_layers = model.config.n_layer + 1   # 含第 0 层（embedding 输出）
    per_layer = [[] for _ in range(n_layers)]
    words, senses = [], []

    for (word, sense, sent) in SAMPLES:
        span = word_span(sent, word)
        if span is None:
            print(f"  跳过（找不到词）：{word} / {sent}")
            continue
        enc = tok(sent, return_offsets_mapping=True, return_tensors="pt")
        offsets = enc.pop("offset_mapping")[0].tolist()
        tids = find_token_indices(offsets, span)
        if not tids:
            print(f"  跳过（对不上 token）：{word} / {sent}")
            continue
        with torch.no_grad():
            out = model(**enc, output_hidden_states=True)
        words.append(word)
        senses.append(sense)
        for L in range(n_layers):
            h = out.hidden_states[L][0]                  # (seq, 768)
            v = h[tids].mean(dim=0).cpu().numpy()        # 目标词的上下文向量
            per_layer[L].append(v)

    print(f"\n样本 {len(words)} 条，词 {sorted(set(words))}")
    print("\n层  义项判别准确率(留一法1NN)  类内-类间余弦差")
    print("-" * 48)
    best = (-1, -1.0)
    for L in range(n_layers):
        V = np.array(per_layer[L], dtype=np.float32)
        acc, gap = eval_layer(V, words, senses)
        flag = ""
        if acc > best[1]:
            best = (L, acc);
        print(f"{L:>2}        {acc:6.3f}                  {gap:+.3f}")
    # 随机基线（两义项各半 → 留一法约 0.5 上下，三义项更低）
    print("-" * 48)
    print(f"最佳层：第 {best[0]} 层，判别准确率 {best[1]:.3f}")
    print("（静态嵌入在第 0 层附近；准确率明显高于 ~0.5 基线 = 义项可分 = 方向成立）")


if __name__ == "__main__":
    main()
