#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diagnose_polysemy_code.py —— 验证「代码一词多义」方向的技术前提。

和 diagnose_polysemy.py 同样的思路，只是把模型换成 CodeBERT（代码上下文嵌入），
样本换成代码里的多义标识符（key / token / class / port / stream），看中间某层能否
把同一个标识符的不同义项分开。若成立，路径①（本地 CodeBERT 做代码一词多义）就站得住。

只在构建期跑一次，用来选层、确认方向，不进演示。
"""

import sys, re
import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# (标识符, 义项, 含该标识符的代码片段)
SAMPLES = [
    ("key", "dict", "value = config[key]"),
    ("key", "dict", "for key in mapping.keys():"),
    ("key", "dict", "result = cache[key]"),
    ("key", "crypto", "ciphertext = encrypt(data, key)"),
    ("key", "crypto", "load the private key from the pem file"),
    ("key", "crypto", "aes_key = derive_key(password, salt)"),

    ("token", "auth", "headers['Authorization'] = 'Bearer ' + token"),
    ("token", "auth", "if token.expired: refresh_session()"),
    ("token", "auth", "verify the access token signature"),
    ("token", "lexer", "for token in lexer.scan(source):"),
    ("token", "lexer", "the parser reads the next token"),
    ("token", "lexer", "if token.kind == IDENTIFIER:"),

    ("class", "oop", "class User(Base): pass"),
    ("class", "oop", "obj = PaymentService()  # instance of the class"),
    ("class", "oop", "the class inherits from Animal"),
    ("class", "css", "element.classList.add(active_class)"),
    ("class", "css", "set the css class to highlight"),
    ("class", "css", "render a div with class container"),

    ("port", "net", "server.listen(port=8080)"),
    ("port", "net", "connect(host, port)"),
    ("port", "net", "the tcp port is already open"),
    ("port", "verb", "port the driver to windows"),
    ("port", "verb", "porting the library to arm64"),
    ("port", "verb", "the code was ported from c++"),

    ("stream", "io", "data = read_bytes(input_stream)"),
    ("stream", "io", "write the buffer to the output stream"),
    ("stream", "io", "close the file stream when done"),
    ("stream", "video", "start the live video stream"),
    ("stream", "video", "the server pushes frames to the media stream"),
    ("stream", "video", "buffer the streaming playback"),
]


def find_token_indices(offsets, span):
    a, b = span
    return [i for i, (s, e) in enumerate(offsets) if s != e and s < b and e > a]


def word_span(sentence, word):
    # 宽松匹配：允许目标符号作为复合词的一部分出现（如 aes_key、input_stream）。
    p = sentence.lower().find(word.lower())
    return (p, p + len(word)) if p >= 0 else None


def cos_sim_matrix(V):
    Vn = V / (np.linalg.norm(V, axis=1, keepdims=True) + 1e-8)
    return Vn @ Vn.T


def eval_layer(vecs, words, senses):
    acc_list, gap_list = [], []
    for w in sorted(set(words)):
        idx = [i for i in range(len(words)) if words[i] == w]
        V = vecs[idx]; S = [senses[i] for i in idx]
        sim = cos_sim_matrix(V); np.fill_diagonal(sim, -2.0)
        hit = sum(1 for i in range(len(idx)) if S[int(np.argmax(sim[i]))] == S[i])
        acc_list.append(hit / len(idx))
        intra, inter = [], []
        for i in range(len(idx)):
            for j in range(i + 1, len(idx)):
                (intra if S[i] == S[j] else inter).append(sim[i, j])
        gap_list.append(np.mean(intra) - np.mean(inter))
    return float(np.mean(acc_list)), float(np.mean(gap_list))


def main():
    import torch
    from transformers import AutoTokenizer, AutoModel

    # CodeBERT 优先；它若只有 .bin 权重（torch<2.6 会因 CVE 拒绝）则回退到有 safetensors 的模型。
    candidates = ["microsoft/codebert-base", "microsoft/unixcoder-base", "gpt2"]
    tok = model = used = None
    for name in candidates:
        try:
            print(f"尝试加载 {name} …")
            tok = AutoTokenizer.from_pretrained(name)
            model = AutoModel.from_pretrained(name, use_safetensors=True).eval()
            used = name
            break
        except Exception as e:
            print(f"  {name} 不可用：{e.__class__.__name__}: {str(e)[:90]}")
    if model is None:
        print("所有候选模型都加载失败"); return
    print(f"\n使用模型：{used}")

    n_layers = (getattr(model.config, "num_hidden_layers", None) or model.config.n_layer) + 1
    per_layer = [[] for _ in range(n_layers)]
    words, senses = [], []

    for (word, sense, sent) in SAMPLES:
        span = word_span(sent, word)
        if span is None:
            print(f"  跳过：{word} / {sent}"); continue
        enc = tok(sent, return_offsets_mapping=True, return_tensors="pt", truncation=True, max_length=48)
        offs = enc.pop("offset_mapping")[0].tolist()
        tids = find_token_indices(offs, span)
        if not tids:
            print(f"  对不上 token：{word} / {sent}"); continue
        with torch.no_grad():
            hs = model(**enc, output_hidden_states=True).hidden_states
        words.append(word); senses.append(sense)
        for L in range(n_layers):
            per_layer[L].append(hs[L][0][tids].mean(dim=0).cpu().numpy())

    print(f"\n样本 {len(words)} 条，标识符 {sorted(set(words))}")
    print("\n层  义项判别准确率(留一法1NN)  类内-类间余弦差")
    print("-" * 48)
    best = (-1, -1.0)
    for L in range(n_layers):
        acc, gap = eval_layer(np.array(per_layer[L], dtype=np.float32), words, senses)
        if acc > best[1]:
            best = (L, acc)
        print(f"{L:>2}        {acc:6.3f}                  {gap:+.3f}")
    print("-" * 48)
    print(f"最佳层：第 {best[0]} 层，判别准确率 {best[1]:.3f}")
    print("（准确率明显高于 ~0.5 基线 = 代码义项可分 = 路径①成立）")


if __name__ == "__main__":
    main()
