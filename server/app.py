#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py — 初学者代码词义教学工具后端：托管前端 + /api/analyze。

/api/analyze(POST {code, lang?}):
  1. Pygments 词法分析把代码切成 token，归到 4 大类：关键字 / 标识符 / 运算符 / 字面量。
  2. 统计每个 token 文本的出现频率（= 权重）。
  3. 一次调 ecnu-max，为关键字和标识符逐个给「初学者能懂的一句话作用」（同名符号按行各给一条，体现一词多义）。
  4. 运算符 / 字面量用规则解释。返回词法地图所需的 token 列表 + 分类 + 解释。

设计：词法身份交给确定性 lexer（准、快、免费、多语言），LLM 只补「在这里干嘛」的上下文语义。
没有 ECNU 凭据时仍能做词法分类（lexer 不需 API），只是没有 LLM 的逐词解释。
"""

import os, json, re, sys, urllib.request
from collections import Counter
from flask import Flask, request, jsonify, send_from_directory

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "web")

app = Flask(__name__, static_folder=None)
SEC = None

CATEGORIES = [
    {"key": "keyword", "name": "关键字", "color": [0.72, 0.5, 1.0]},
    {"key": "identifier", "name": "标识符", "color": [0.4, 0.72, 1.0]},
    {"key": "operator", "name": "运算符", "color": [1.0, 0.62, 0.3]},
    {"key": "literal", "name": "字面量", "color": [0.5, 0.85, 0.55]},
]

OP_HINT = {
    "=": "赋值：把右边的值放进左边", "==": "判断两边是否相等", "!=": "判断两边是否不等",
    "+": "加法 / 拼接", "-": "减法", "*": "乘法", "/": "除法", "%": "取余数",
    "<": "小于", ">": "大于", "<=": "小于等于", ">=": "大于等于",
    "and": "并且（逻辑与）", "or": "或者（逻辑或）", "not": "取反", "+=": "加到自己身上", "->": "返回类型标注",
}

# 关键字固定解释（语言层面恒定，不必每次问 LLM —— 又快又稳）
KW_HINT = {
    "def": "定义一个函数", "return": "把结果返回给调用处", "if": "如果条件成立就执行", "elif": "否则如果",
    "else": "否则", "for": "循环：依次取每个元素", "while": "当条件成立时反复执行", "in": "判断是否在其中 / 遍历",
    "import": "导入一个模块", "from": "从模块里导入", "as": "起一个别名", "class": "定义一个类",
    "pass": "占位，什么也不做", "break": "跳出循环", "continue": "跳过本次、进入下一轮", "with": "在上下文中执行，用完自动收尾",
    "try": "尝试执行", "except": "捕获异常", "finally": "无论如何都执行", "raise": "抛出异常", "lambda": "匿名小函数",
    "yield": "生成器逐个返回值", "global": "声明使用全局变量", "nonlocal": "使用外层函数的变量",
    "and": "逻辑与（并且）", "or": "逻辑或（或者）", "not": "逻辑取反", "is": "判断是否同一个对象",
    "None": "空值", "True": "真", "False": "假", "async": "异步定义", "await": "等待异步结果", "del": "删除",
}


def load_secrets():
    p = os.path.join(HERE, "secrets.json")
    if not os.path.exists(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


ID_HINT = {
    "self": "当前对象实例的引用",
    "cls": "当前类的引用",
    "__init__": "初始化方法，创建对象时自动调用",
    "__str__": "转字符串时调用",
    "__repr__": "对象文字表示",
    "__name__": "模块或类的名称",
    "__main__": "主程序入口标志",
}


def ctx_hint(toks, i):
    if i <= 0:
        return None
    prev = toks[i - 1]["text"]
    if prev == "def": return "函数名"
    if prev == "class": return "类名"
    if prev in ("import", "from"): return "模块"
    if prev == "as": return "别名"
    if prev == "@": return "装饰器"
    return None


def categorize(tt):
    from pygments.token import Keyword, Name, Operator, Number, String, Literal
    if tt in Keyword: return "keyword"
    if tt in Name: return "identifier"
    if tt in Operator: return "operator"
    if tt in Number or tt in String or tt in Literal: return "literal"
    return None


def lex_code(code, lang):
    from pygments.lexers import get_lexer_by_name, guess_lexer
    from pygments.lexers import PythonLexer
    lexer = None
    if lang:
        try: lexer = get_lexer_by_name(lang)
        except Exception: lexer = None
    if lexer is None:
        try: lexer = guess_lexer(code)
        except Exception: lexer = PythonLexer()
    toks = []
    for idx, tt, val in lexer.get_tokens_unprocessed(code):
        if not val.strip():
            continue
        cat = categorize(tt)
        if cat is None:
            continue
        line = code.count("\n", 0, idx) + 1
        col = idx - (code.rfind("\n", 0, idx) + 1)
        toks.append({"text": val, "cat": cat, "ttype": str(tt), "line": line, "col": col})
    # 合并相邻的字符串片段（引号 + 内容）成一个字面量 token
    merged = []
    for t in toks:
        if (merged and merged[-1]["cat"] == "literal" and "String" in merged[-1]["ttype"]
                and "String" in t["ttype"] and merged[-1]["line"] == t["line"]):
            merged[-1]["text"] += t["text"]
        else:
            merged.append(t)
    return merged, lexer.name


def llm_explain(code, targets):
    if not SEC or not SEC.get("api_key") or not targets:
        return {}
    lines = code.split("\n")
    numbered = "\n".join(f"{i+1}: {l}" for i, l in enumerate(lines))
    want = "；".join(f'{t["text"]}(第{t["line"]}行)' for t in targets[:80])
    prompt = (f"下面是给编程初学者看的代码。请用初学者能懂的大白话，逐个解释这些词在这段代码里"
              f"「是什么、起什么作用」，每条不超过 30 字。同名的词在不同行可能作用不同，要分别解释。\n\n"
              f"代码：\n{numbered}\n\n要解释的词：{want}\n\n"
              f"只输出 JSON：{{\"items\":[{{\"text\":\"def\",\"line\":1,\"explain\":\"定义一个函数\"}}]}}")
    try:
        req = urllib.request.Request(SEC["base_url"].rstrip("/") + "/chat/completions",
            data=json.dumps({"model": SEC["chat_model"], "messages": [{"role": "user", "content": prompt}]}).encode("utf-8"),
            method="POST", headers={"Authorization": "Bearer " + SEC["api_key"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            content = json.loads(r.read().decode("utf-8"))["choices"][0]["message"]["content"]
        import re
        m = re.search(r"\{.*\}", content, re.S)
        items = json.loads(m.group())["items"]
        return {(it["text"], int(it["line"])): it.get("explain", "") for it in items}
    except Exception as e:
        print("llm_explain 失败:", e)
        return {}


def static_explain(t):
    if t["cat"] == "operator":
        return OP_HINT.get(t["text"], "运算符")
    if t["cat"] == "literal":
        if t["ttype"].startswith("Token.Literal.String") or "String" in t["ttype"]:
            return "字符串：一段文本"
        if "Number" in t["ttype"]:
            return "数字字面量"
        return "字面量：一个固定的值"
    return None


def analyze(code, lang):
    toks, lexer_name = lex_code(code, lang)
    if not toks:
        return {"error": "没有可分析的 token"}
    freq = Counter(t["text"] for t in toks)
    for i, t in enumerate(toks):
        t["id"] = i
        t["weight"] = freq[t["text"]]
    for i, t in enumerate(toks):
        if t["cat"] == "keyword":
            t["explain"] = KW_HINT.get(t["text"], "关键字")
        elif t["cat"] == "identifier":
            if t["text"] in ID_HINT:
                t["explain"] = ID_HINT[t["text"]]
            else:
                t["explain"] = None
                h = ctx_hint(toks, i)
                if h:
                    t["quick"] = h
        else:
            t["explain"] = static_explain(t)
    counts = {c["key"]: sum(1 for t in toks if t["cat"] == c["key"]) for c in CATEGORIES}
    return {"schema": "code-lex/v1",
            "meta": {"code": code, "lang": lexer_name, "categories": CATEGORIES, "counts": counts,
                     "llm": bool(SEC and SEC.get("api_key")), "count": len(toks)},
            "tokens": toks}


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    body = request.get_json(silent=True) or {}
    code = (body.get("code") or "").strip()
    if not code:
        return jsonify({"error": "empty"}), 400
    try:
        return jsonify(analyze(code, body.get("lang") or "python"))
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/explain", methods=["POST"])
def api_explain():
    b = request.get_json(silent=True) or {}
    code = (b.get("code") or "").strip()
    text = (b.get("text") or "").strip()
    line = b.get("line")
    if not code or not text:
        return jsonify({"explain": None}), 400
    if not SEC or not SEC.get("api_key"):
        return jsonify({"explain": None})
    try:
        numbered = "\n".join(f"{i+1}: {l}" for i, l in enumerate(code.split("\n")))
        sys_msg = "代码讲解助手。一句≤20字大白话解释指定标识符，只输出JSON。禁止改代码/给建议。"
        prompt = (f"```\n{numbered}\n```\n第{line}行的`{text}`是什么、干什么？{{\"explain\":\"...\"}}")
        req = urllib.request.Request(SEC["base_url"].rstrip("/") + "/chat/completions",
            data=json.dumps({"model": SEC["chat_model"], "max_tokens": 80, "temperature": 0,
                             "messages": [{"role": "system", "content": sys_msg}, {"role": "user", "content": prompt}]}).encode("utf-8"),
            method="POST", headers={"Authorization": "Bearer " + SEC["api_key"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=40) as r:
            content = json.loads(r.read().decode("utf-8"))["choices"][0]["message"]["content"]
        m = re.search(r"\{.*\}", content, re.S)
        explain = (json.loads(m.group()).get("explain") if m else content.strip())
        return jsonify({"explain": (explain or "").strip()[:80]})
    except Exception as e:
        return jsonify({"explain": None, "error": str(e)})


@app.route("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.route("/<path:p>")
def static_files(p):
    return send_from_directory(WEB, p)


if __name__ == "__main__":
    SEC = load_secrets()
    print(f"词法：Pygments；LLM 语义：{'ecnu-max（已配凭据）' if SEC.get('api_key') else '未配凭据（仅词法分类，无逐词解释）'}")
    print("打开 http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
