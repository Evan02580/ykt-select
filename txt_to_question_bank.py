#!/usr/bin/env python3
"""将常见中文 TXT 题库转换为适合 OCR 检索的 JSON（仅使用标准库）。"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import unicodedata


TYPE_NAMES = {
    "单选": "single_choice", "多选": "multiple_choice", "不定项选择": "multiple_choice",
    "判断": "true_false", "主观": "subjective", "简答": "subjective",
    "问答": "subjective", "论述": "subjective", "填空": "fill_blank",
}
TYPE_PATTERN = "(?:" + "|".join(TYPE_NAMES) + ")(?:题)?"
TYPED = re.compile(r"^\s*(?:(\d+)\s*[.、:)]?\s*)?(" + TYPE_PATTERN + r")\s*")
NUMBERED = re.compile(r"^\s*(\d+)\s*[.、)]\s*(.+)")
SCORE = re.compile(r"^\s*(?:[（(]?\s*\d+(?:\.\d+)?\s*分\s*[）)]?|\d+\s*[（(]分[）)])\s*")
ANSWER = re.compile(r"(?:参考答案|正确答案|标准答案|答案)\s*[:：]\s*")
EXPLANATION = re.compile(r"(?:答案解析|参考解析|解析)\s*[:：]\s*")
# 允许 A. / A、 / (A) / A文字 / 多个选项挤在同一行；按 A、B、C 顺序接受。
OPTION = re.compile(r"[（(]\s*([A-Ha-h])\s*[）)]\s*|(?<![A-Za-z])([A-H])(?:\s*[.、:：)）]\s*|\s+|(?=[\u3400-\u9fff《“\"‘])|(?=[A-Z][a-z]))")
INLINE = re.compile(r"[（(]\s*([A-Ha-h](?:[A-Ha-h,，、\s]*[A-Ha-h])?|√|✓|×|✗|正确|错误|对|错|true|false)\s*[）)]\s*[。.!！]?\s*$", re.I)
CHAPTER = re.compile(r"^(?:第[一二三四五六七八九十百\d]+[章节篇]|[一二三四五六七八九十]+[、.]).*")
NOISE = re.compile(r"^(?:编辑于|发布于|未登录用户|默认$|最新$|分享$|申请转载$|赞同\s*\d*|\d+\s*条评论|\d{4}年.*补充)")


def clean(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", re.sub(r"[\u200b-\u200f\ufeff]", "", text)).strip()


def normalize(text: str) -> str:
    """浏览器检索端应使用同样的 NFKC + 小写 + 去标点/空白规则。"""
    return "".join(c for c in clean(text).lower() if c.isalnum())


def read_text(path: Path, encoding: str | None = None) -> tuple[str, str]:
    raw = path.read_bytes()
    if encoding:
        return raw.decode(encoding), encoding
    # 先识别 BOM，避免 UTF-16 文件被误认作 UTF-8 或 GB18030。
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16"), "utf-16"
    if b"\x00" in raw:
        raise ValueError("文件含 NUL，可能为无 BOM 的 UTF-16；请指定 --encoding utf-16-le/be")
    for candidate in ("utf-8-sig", "gb18030", "big5"):
        try:
            return raw.decode(candidate), candidate
        except UnicodeDecodeError:
            pass
    raise ValueError("无法识别编码，请用 --encoding 指定；未使用替换字符以免损坏题目")


def parse_answer(text: str) -> tuple[list[str], bool | None]:
    value = clean(text).strip("()[]【】。.")
    if value.lower() in {"√", "✓", "正确", "对", "是", "true"}:
        return [], True
    if value.lower() in {"×", "✗", "错误", "错", "否", "false"}:
        return [], False
    if re.fullmatch(r"[A-Ha-h](?:[A-Ha-h\s,，、;；/|]*[A-Ha-h])?", value):
        return sorted(set(re.findall(r"[A-H]", value.upper()))), None
    return [], None


def split_options(text: str) -> tuple[str, list[dict]]:
    accepted = []
    for match in OPTION.finditer(text):
        label = (match.group(1) or match.group(2)).upper()
        if label == chr(ord("A") + len(accepted)):
            accepted.append((match, label))
    if not accepted:
        return text.strip(), []
    result = []
    for i, (match, label) in enumerate(accepted):
        end = accepted[i + 1][0].start() if i + 1 < len(accepted) else len(text)
        result.append({"label": label, "text": clean(text[match.end():end])})
    return text[:accepted[0][0].start()].strip(), result


def make_record(block: dict, filename: str) -> dict:
    # 保留换行用于识别分行选项，展示文字再统一空白。
    body = "\n".join(block["body"])
    answer_match = ANSWER.search(body)
    answer_raw, explanation = "", ""
    warnings = []
    if answer_match:
        answer_raw = body[answer_match.end():].strip()
        body = body[:answer_match.start()].strip()
        explanation_match = EXPLANATION.search(answer_raw)
        if explanation_match:
            explanation = clean(answer_raw[explanation_match.end():])
            answer_raw = answer_raw[:explanation_match.start()].strip()
    # 先移除题干行末答案，防止把“题目是(A)”误当成一个空 A 选项。
    body_lines = body.splitlines()
    if body_lines:
        stem_answer = INLINE.search(body_lines[0])
        if stem_answer and stem_answer.start() > 0 and not OPTION.match(body_lines[0]):
            inline_raw = stem_answer.group(1)
            body_lines[0] = body_lines[0][:stem_answer.start()].strip()
            body = "\n".join(body_lines)
            if answer_raw and parse_answer(answer_raw) != parse_answer(inline_raw):
                warnings.append("inline_answer_conflict")
            elif not answer_raw:
                answer_raw = inline_raw
    question, options = split_options(body)
    inline = INLINE.search(question)
    if inline:
        inline_answer = inline.group(1)
        question = question[:inline.start()].strip()
        if answer_raw and parse_answer(answer_raw) != parse_answer(inline_answer):
            warnings.append("inline_answer_conflict")
        elif not answer_raw:
            answer_raw = inline_answer
    labels, boolean = parse_answer(answer_raw)
    kind = block["type"]
    if kind == "unknown":
        if boolean is not None:
            kind = "true_false"
        elif options and labels:
            kind = "multiple_choice" if len(labels) > 1 else "single_choice"
        elif answer_raw:
            kind = "subjective"
    option_map = {o["label"]: o["text"] for o in options}
    answer_texts = [option_map[x] for x in labels if x in option_map]
    if boolean is not None:
        answer_texts = ["正确" if boolean else "错误"]
    elif not labels and answer_raw:
        answer_texts = [clean(answer_raw)]
    question = clean(question).lstrip(".、 ")
    if not question:
        warnings.append("missing_question")
    if not answer_raw:
        warnings.append("missing_answer")
    if labels and not options:
        warnings.append("missing_options")
    if any(x not in option_map for x in labels):
        warnings.append("answer_option_not_found")
    if kind == "single_choice" and len(labels) > 1:
        warnings.append("single_choice_has_multiple_answers")
    if kind in {"single_choice", "multiple_choice"} and not labels:
        warnings.append("unrecognized_choice_answer")
    if kind == "true_false" and boolean is None:
        warnings.append("unrecognized_boolean_answer")
    if any(not o["text"] for o in options):
        warnings.append("empty_option")
    searchable = normalize(question + " " + " ".join(o["text"] for o in options))
    return {
        "type": kind, "question": question, "options": options,
        "answer": {"raw": clean(answer_raw), "labels": labels, "texts": answer_texts, "boolean": boolean},
        "explanation": explanation,
        "search": {"question": normalize(question), "text": searchable,
                   "bigrams": sorted({searchable[i:i+2] for i in range(len(searchable)-1)})},
        "sources": [{"file": filename, "line_start": block["start"], "line_end": block["end"],
                     "number": block["number"], "chapter": block["chapter"],
                     "raw": "\n".join(block["raw"])}],
        "warnings": warnings,
    }


def parse_text(text: str, filename: str) -> tuple[list[dict], list[dict]]:
    records, ignored = [], []
    current = None
    chapter = ""

    def flush():
        nonlocal current
        if current:
            record = make_record(current, filename)
            if (current["type"] == "unknown" and not record["options"]
                    and not record["answer"]["raw"] and not re.search(r"[?？]", record["question"])):
                ignored.append({"file": filename, "line": current["start"],
                                "text": "\n".join(current["raw"]), "reason": "unrecognized_block"})
            else:
                records.append(record)
            current = None

    for line_no, raw_line in enumerate(text.splitlines(), 1):
        line = clean(raw_line)
        if not line:
            continue
        typed = TYPED.match(line)
        numbered = NUMBERED.match(line)
        if current and not EXPLANATION.match(line):
            existing = "\n".join(current["body"])
            previous_answer = ANSWER.search(existing)
            if previous_answer and parse_answer(existing[previous_answer.end():]) != ([], None):
                flush()
        if typed or numbered:
            flush()
            if typed:
                number = typed.group(1)
                type_name = typed.group(2).removesuffix("题")
                kind = TYPE_NAMES[type_name]
                rest = SCORE.sub("", line[typed.end():], count=1).lstrip(".、 ")
            else:
                number, rest = numbered.groups()
                kind = "unknown"
            current = {"number": number, "type": kind, "chapter": chapter,
                       "start": line_no, "end": line_no, "body": [rest] if rest else [], "raw": [raw_line]}
        elif CHAPTER.match(line):
            flush()
            chapter = line
        elif NOISE.match(line):
            flush()
            ignored.append({"file": filename, "line": line_no, "text": raw_line, "reason": "web_noise"})
        elif current is not None:
            current["body"].append(line)
            current["raw"].append(raw_line)
            current["end"] = line_no
        else:
            # 无题号、无题型的块：由题干起始，后续以空行不分割，答案或下一题分割。
            if OPTION.match(line) or ANSWER.match(line) or re.fullmatch(r"\d+", line):
                ignored.append({"file": filename, "line": line_no, "text": raw_line, "reason": "orphan_line"})
            else:
                current = {"number": None, "type": "unknown", "chapter": chapter,
                           "start": line_no, "end": line_no, "body": [line], "raw": [raw_line]}
    flush()
    return records, ignored


def record_key(record: dict, with_answer: bool = True) -> str:
    parts = [record["search"]["question"], [(o["label"], normalize(o["text"])) for o in record["options"]]]
    if with_answer:
        answer = record["answer"]
        parts.append([answer["labels"], answer["boolean"], [normalize(t) for t in answer["texts"]]])
    return json.dumps(parts, ensure_ascii=False, sort_keys=True)


def convert(paths: list[Path], encoding: str | None = None) -> tuple[dict, dict]:
    merged, ignored, files, failed = {}, [], [], []
    candidate_count = 0
    for path in paths:
        try:
            text, detected = read_text(path, encoding)
        except (UnicodeError, ValueError, OSError) as exc:
            failed.append({"file": str(path), "error": str(exc)})
            continue
        records, skipped = parse_text(text, str(path))
        files.append({"file": str(path), "encoding": detected, "candidates": len(records)})
        candidate_count += len(records)
        ignored.extend(skipped)
        for record in records:
            key = record_key(record)
            if key in merged:
                merged[key]["sources"].extend(record["sources"])
                merged[key]["warnings"] = sorted(set(merged[key]["warnings"] + record["warnings"]))
            else:
                record["id"] = "q_" + hashlib.sha256(key.encode()).hexdigest()[:20]
                merged[key] = record
    records = list(merged.values())
    groups = defaultdict(list)
    for record in records:
        # 比较选项内容和答案内容，允许选项顺序变化；题干相同但选项不同不判冲突。
        group_key = (record["search"]["question"], tuple(sorted(normalize(o["text"]) for o in record["options"])))
        groups[group_key].append(record)
    conflicts = []
    for group in groups.values():
        signatures = {tuple(sorted(normalize(t) for t in r["answer"]["texts"])) for r in group if r["answer"]["raw"]}
        if len(signatures) > 1:
            conflicts.append([r["id"] for r in group])
            for record in group:
                record["warnings"].append("conflicting_answers")
    for record in records:
        record["status"] = "needs_review" if record["warnings"] else "ready"
    stats = {"input_files": len(paths), "parsed_files": len(files), "candidates": candidate_count,
             "questions": len(records), "duplicates_merged": candidate_count - len(records),
             "ready": sum(r["status"] == "ready" for r in records),
             "needs_review": sum(r["status"] == "needs_review" for r in records),
             "types": dict(Counter(r["type"] for r in records)), "conflict_groups": len(conflicts)}
    bank = {"schema_version": "1.0", "stats": stats, "questions": records}
    report = {"stats": stats, "files": files, "failed_files": failed, "conflicts": conflicts,
              "issues": [{"id": r["id"], "question": r["question"], "warnings": r["warnings"],
                          "sources": [{k: v for k, v in s.items() if k != "raw"} for s in r["sources"]]}
                         for r in records if r["warnings"]], "ignored_lines": ignored}
    return bank, report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="*", default=["."], help="TXT 文件或文件夹（默认当前文件夹）")
    parser.add_argument("-o", "--output", type=Path, default=Path("question_bank.json"))
    parser.add_argument("--report", type=Path, help="检查报告，默认为输出名.report.json")
    parser.add_argument("--recursive", action="store_true", help="递归扫描子目录")
    parser.add_argument("--encoding", help="手动指定编码，例如 gb18030 / utf-16-le")
    args = parser.parse_args()
    paths = set()
    for source in args.inputs:
        path = Path(source)
        if path.is_dir():
            paths.update(p.resolve() for p in (path.rglob("*") if args.recursive else path.iterdir())
                         if p.is_file() and p.suffix.lower() == ".txt")
        elif path.is_file():
            paths.add(path.resolve())
        else:
            parser.error(f"输入不存在：{source}")
    if not paths:
        parser.error("没有找到 TXT 文件")
    report_path = args.report or args.output.with_suffix(".report.json")
    if args.output.resolve() == report_path.resolve() or {args.output.resolve(), report_path.resolve()} & paths:
        parser.error("题库、报告和输入文件路径必须互不相同")
    bank, report = convert(sorted(paths), args.encoding)
    for target, payload in ((args.output, bank), (report_path, report)):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(bank["stats"], ensure_ascii=False, indent=2))
    print(f"题库：{args.output.resolve()}\n报告：{report_path.resolve()}")
    return 1 if report["failed_files"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
