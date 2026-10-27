// ==UserScript==
// @name         题库检索助手
// @namespace    http://tampermonkey.net/
// @version      5.1.2
// @description  本地题库检索、OCR 与自动选择选项
// @author       风之子（原版）；Evan（检索版改编）
// @license      GPL-3.0-only
// @match        *://*.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js
// ==/UserScript==

(() => {
  'use strict';
  const KEYS = { bank: 'ykt_local_bank_v1', auto: 'ykt_local_auto_ocr_v1', window: 'ykt_local_window_v1', controls: 'ykt_local_controls_collapsed_v1' };
  const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const bigrams = text => new Set(text.length < 2 ? [text] : Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2)));
  const types = { single_choice: '单选题', multiple_choice: '多选题', true_false: '判断题', subjective: '主观题', fill_blank: '填空题', unknown: '题目' };

  function validateBank(payload) {
    const list = Array.isArray(payload) ? payload : payload?.questions;
    if (!Array.isArray(list) || !list.length) throw new Error('题库必须包含非空 questions 数组，或直接为题目数组');
    if (list.length > 50000) throw new Error('单次最多导入 50000 道题');
    return list.map((q, i) => {
      if (!q || typeof q.question !== 'string' || !q.question.trim()) throw new Error(`第 ${i + 1} 条缺少 question 题干，请先修复题库`);
      if (!Array.isArray(q.options) || !q.answer || typeof q.answer !== 'object') throw new Error(`第 ${i + 1} 条需要 options 数组和 answer 对象，请使用转换脚本生成的格式`);
      const options = q.options.map(o => {
        if (!o || typeof o.label !== 'string' || typeof o.text !== 'string') throw new Error(`第 ${i + 1} 条选项需要 label 和 text`);
        return { label: o.label, text: o.text };
      });
      if (!Array.isArray(q.answer.labels) || !Array.isArray(q.answer.texts)
          || !q.answer.labels.every(x => typeof x === 'string') || !q.answer.texts.every(x => typeof x === 'string')
          || ![null, true, false].includes(q.answer.boolean ?? null)) throw new Error(`第 ${i + 1} 条 answer 字段格式不正确`);
      return {
        id: typeof q.id === 'string' ? q.id : `import_${i + 1}`, question: q.question.trim(),
        type: Object.hasOwn(types, q.type) ? q.type : 'unknown', options,
        answer: { raw: String(q.answer.raw ?? ''), labels: q.answer.labels, texts: q.answer.texts, boolean: q.answer.boolean ?? null },
        explanation: String(q.explanation ?? ''), warnings: Array.isArray(q.warnings) ? q.warnings.map(String) : [],
        status: q.status === 'needs_review' ? 'needs_review' : 'ready',
        sources: Array.isArray(q.sources) ? q.sources.map(s => ({
          file: String(s?.file ?? ''), line_start: Number(s?.line_start) || null, chapter: String(s?.chapter ?? '')
        })) : []
      };
    });
  }

  class QuestionIndex {
    constructor(questions) {
      this.rows = questions.map(question => {
        const stem = normalize(question.question), options = question.options.map(o => normalize(o.text));
        return { question, stem, options, content: stem + options.join(''), grams: bigrams(stem + options.join('')) };
      });
      this.frequency = new Map(); this.postings = new Map(); this.cache = new Map();
      this.rows.forEach((row, i) => { for (const gram of row.grams) {
        this.frequency.set(gram, (this.frequency.get(gram) || 0) + 1);
        if (!this.postings.has(gram)) this.postings.set(gram, []);
        this.postings.get(gram).push(i);
      } });
      this.weights = new Map([...this.frequency].map(([gram, frequency]) => [gram, 1 + Math.log(1 + this.rows.length / (1 + frequency))]));
      this.unknownWeight = 1 + Math.log(1 + this.rows.length);
      for (const row of this.rows) {
        row.stemFeature = this.feature(bigrams(row.stem)); row.contentFeature = this.feature(row.grams);
        row.optionFeatures = row.options.map(option => this.feature(bigrams(option)));
      }
    }
    weight(gram) { return this.weights.get(gram) ?? this.unknownWeight; }
    feature(grams) { return { grams, weight: [...grams].reduce((sum, gram) => sum + this.weight(gram), 0) }; }
    overlap(candidate, query) {
      if (!candidate.grams.size || !query.grams.size) return 0;
      let intersection = 0;
      const [smaller, larger] = candidate.grams.size < query.grams.size ? [candidate.grams, query.grams] : [query.grams, candidate.grams];
      for (const gram of smaller) if (larger.has(gram)) intersection += this.weight(gram);
      return intersection ? 0.6 * intersection / candidate.weight + 0.4 * (2 * intersection / (candidate.weight + query.weight)) : 0;
    }
    search(text, limit = 6) {
      const input = String(text).slice(0, 10000), query = normalize(input);
      if (query.length < 2) return [];
      limit = Math.max(1, Math.min(20, limit));
      if (this.cache.has(input)) return this.cache.get(input).slice(0, limit);
      const grams = bigrams(query), queryFeature = this.feature(grams), candidates = new Set();
      for (const gram of grams) for (const i of this.postings.get(gram) || []) candidates.add(i);
      const keywords = input.normalize('NFKC').split(/[\s,，;；]+/).map(normalize).filter(x => x.length >= 2);
      const matches = [...candidates].sort((a, b) => a - b).map(i => {
        const row = this.rows[i];
        const stemMatch = row.stem.length >= 6 && query.includes(row.stem) ? 1 : this.overlap(row.stemFeature, queryFeature);
        const contentMatch = this.overlap(row.contentFeature, queryFeature);
        const optionMatch = row.options.length ? row.options.reduce((sum, option, i) => sum + (option.length >= 2 && query.includes(option) ? 1 : this.overlap(row.optionFeatures[i], queryFeature)), 0) / row.options.length : stemMatch;
        const keywordMatch = keywords.length > 1 ? keywords.filter(k => row.content.includes(k)).length / keywords.length : 0;
        const base = 0.45 * stemMatch + 0.35 * contentMatch + 0.2 * optionMatch;
        let score = Math.max(base, 0.65 * keywordMatch + 0.35 * base), matchReason = '文字相似度';
        // 短查询必须按查询覆盖率处理，不能被整题的长选项稀释后过滤。
        if (query.length >= 3 && row.stem.includes(query)) {
          score = Math.max(score, 0.94 + 0.05 * query.length / row.stem.length); matchReason = '题干包含关键词';
        }
        const exactOption = row.options.find(o => query.length >= 3 && o.includes(query));
        if (exactOption) { score = Math.max(score, 0.91 + 0.05 * query.length / exactOption.length); matchReason = '选项包含关键词'; }
        return { ...row, score, matchReason };
      }).filter(row => row.score >= 0.18).sort((a, b) => b.score - a.score).slice(0, 20);
      if (this.cache.size >= 24) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(input, matches);
      return matches.slice(0, limit);
    }
  }

  function trustedPageText(index, text) {
    const best = index.search(text, 1)[0];
    if (!best || best.score < 0.7) return false;
    const query = normalize(text);
    const exactOptions = best.options.filter(o => o.length >= 4 && query.includes(o)).length;
    // 完整题干+选项交叉验证，避免防复制字体的乱码被当成可信 DOM 文字。
    return (best.stem.length >= 10 && query.includes(best.stem)
      && (!best.options.length || exactOptions >= Math.min(2, best.options.length)))
      || exactOptions >= 3;
  }

  function stripOptionLabel(text) {
    return String(text || '').normalize('NFKC').trim()
      .replace(/^[\s□☐☑■▢囗口|丨]+/, '')
      .replace(/^(?:[([【]\s*[A-H]\s*[)\]】]|[A-H]\s*[.、:：)]|[A-H](?=\s|[\u3400-\u9fff]))\s*/i, '').trim();
  }
  function parseRecognizedOptions(text, count) {
    const input = String(text || '').normalize('NFKC').replace(/(^|\n)[\s□☐☑■▢囗口|丨]+(?=[A-H([【])/g, '$1');
    const pattern = /[([【]\s*([A-H])\s*[)\]】]\s*|(?:^|\n)\s*([A-H])(?:\s*[.、:：)]\s*|\s+|(?=[\u3400-\u9fff]))/gm;
    const markers = [...input.matchAll(pattern)];
    if (markers.length !== count || markers.some((m, i) => (m[1] || m[2]) !== String.fromCharCode(65 + i))) {
      throw new Error('OCR 未能明确区分所有选项，不能按题库字母猜选项');
    }
    return markers.map((m, i) => input.slice(m.index + m[0].length, markers[i + 1]?.index ?? input.length)
      .replace(/\n\s*(?:上一题|下一题|提交(?:答案)?)[\s\S]*$/, '').trim());
  }
  function optionsByTextOrder(text, options) {
    const lines = String(text || '').split(/\r?\n/).map(normalize);
    const whole = lines.join(''), choices = options.map(option => normalize(option.text));
    if (choices.some(choice => choice.length < 2) || new Set(choices).size !== choices.length) throw new Error('选项文字过短或重复，无法按内容唯一定位');
    const offsets = []; let total = 0;
    for (const line of lines) { offsets.push(total); total += line.length; }
    const found = choices.map((choice, index) => {
      const start = whole.indexOf(choice);
      if (start < 0 || whole.indexOf(choice, start + 1) >= 0) throw new Error('OCR 中有选项缺失或重复，需逐项复核');
      const startLine = offsets.findLastIndex(offset => offset <= start);
      const endLine = offsets.findLastIndex(offset => offset < start + choice.length);
      const prefix = whole.slice(offsets[startLine], start);
      if (!/^[a-h0-9囗口o]{0,4}$/.test(prefix)) throw new Error('选项不在独立的选项行中');
      return {start,end:start+choice.length,startLine,endLine,text:options[index].text};
    }).sort((a,b)=>a.start-b.start);
    if (found.some((item,i)=>i && (item.start<found[i-1].end || item.startLine<=found[i-1].endLine))) throw new Error('选项位置重叠，不能确定排列顺序');
    return found.map(item=>item.text);
  }
  function identifyOptionText(reading, options) {
    const value = normalize(reading);
    const matches = options.filter(option => {
      const expected = normalize(option.text);
      if (!expected || !value.endsWith(expected)) return false;
      return /^[a-h0-9囗口o]{0,4}$/.test(value.slice(0, value.length - expected.length));
    });
    if (matches.length !== 1) throw new Error('选项 OCR 内容无法与题库唯一对应');
    return matches[0].text;
  }
  function optionTextRect(node) {
    const doc = node.ownerDocument, rectangles = [], walker = doc.createTreeWalker(node, 4);
    let text;
    while ((text = walker.nextNode())) {
      const raw = text.nodeValue || '', trimmed = raw.trim(), normalized = normalize(trimmed);
      if (!normalized || /^[a-h]$/i.test(normalized) || !text.parentElement || !visible(text.parentElement)
          || text.parentElement.closest('svg, i, .iconfont, .el-radio__inner, .el-checkbox__inner, script, style')) continue;
      const content = stripOptionLabel(raw);
      if (!normalize(content)) continue;
      const range = doc.createRange(); range.selectNodeContents(text);
      const start = raw.indexOf(content); if (start > 0) range.setStart(text, start);
      for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) rectangles.push(rect);
    }
    const outer = node.getBoundingClientRect();
    if (!rectangles.length) return outer;
    const left = Math.max(outer.left, Math.min(...rectangles.map(r=>r.left))-4);
    const top = Math.max(outer.top, Math.min(...rectangles.map(r=>r.top))-4);
    const right = Math.min(outer.right, Math.max(...rectangles.map(r=>r.right))+4);
    const bottom = Math.min(outer.bottom, Math.max(...rectangles.map(r=>r.bottom))+4);
    return {left,top,width:Math.max(1,right-left),height:Math.max(1,bottom-top)};
  }
  function optionImageSize(width, height, nativeFontSize) {
    const scale = Math.min(4, Math.max(1,64/Math.max(8,nativeFontSize)), Math.sqrt(3500000/(width*height)));
    return {width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale))};
  }
  function resizeOptionImage(image, nativeFontSize) {
    const size=optionImageSize(image.width,image.height,nativeFontSize);
    const canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
    return canvas;
  }
  function booleanAnswer(text) {
    const value = normalize(text);
    if (['正确', '对', '是', 'true', 'correct', 'yes'].includes(value) || /^[√✓✔☑]$/.test(String(text).trim())) return true;
    if (['错误', '错', '否', 'false', 'incorrect', 'wrong', 'no'].includes(value) || /^[×✕✖✗✘☒xX]$/.test(String(text).trim())) return false;
    return null;
  }
  function booleanIconMeaning(value, bareName = false) {
    for (const token of String(value || '').split(/[\s#]+/)) {
      const name = token.replace(/^(?:el-icon-|iconfont[-_]|icon[-_]|fa[-_]|anticon[-_]|layui-icon[-_])/, '')
        .replace(/^(?:circle|square|round)[-_]/, '').replace(/[-_](?:circle|square|o|fill|outline|filled)$/, '').replace(/\d+$/, '');
      if (!bareName && name === token) continue;
      if (/^(?:check|checkmark|tick|correct|true|dui|duihao|zhengque)$/i.test(name)) return true;
      if (/^(?:close|cross|times|false|wrong|error|cuo|cuohao|cuowu)$/i.test(name)) return false;
    }
    return null;
  }
  function unquoteCssContent(value) {
    return String(value || '').replace(/^['"]|['"]$/g, '').replace(/\\([0-9a-f]{1,6})\s?/gi,
      (_, hex) => { const code = parseInt(hex, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; });
  }
  function booleanOptionValue(node) {
    const signals = new Set();
    const add = value => { if (value !== null) signals.add(value); };
    add(booleanAnswer(stripOptionLabel(node.innerText)));
    const view = node.ownerDocument.defaultView;
    for (const part of [node, ...node.querySelectorAll('*')]) {
      // radio 的选中装饰不等于“正确”；只读取选项本身的内容图标。
      if (part.closest('.el-radio__inner, .el-checkbox__inner')) continue;
      for (const attr of ['aria-label', 'title', 'alt', 'data-answer', 'data-value', 'value']) {
        const text = part.getAttribute(attr);
        if (text !== null) add(booleanAnswer(text));
      }
      if (!visible(part)) continue;
      add(booleanAnswer(String(part.textContent || '').trim()));
      add(booleanIconMeaning(part.getAttribute('class')));
      for (const attr of ['data-icon', 'data-name', 'href', 'xlink:href']) {
        const text = part.getAttribute(attr);
        if (text !== null) add(booleanIconMeaning(text, true));
      }
      for (const pseudo of ['::before', '::after']) {
        add(booleanAnswer(unquoteCssContent(view.getComputedStyle(part, pseudo).content)));
      }
    }
    return signals.size === 1 ? [...signals][0] : null;
  }
  function recognizedBooleanOptions(text, count) {
    if (count !== 2) throw new Error('判断题必须有两个明确的对错选项');
    const values = String(text || '').split(/\r?\n/).map(line => booleanAnswer(stripOptionLabel(line))).filter(value => value !== null);
    if (values.length !== 2 || new Set(values).size !== 2) throw new Error('无法辨认判断题的 ✓ / × 图标；请手动选择本题');
    return values.map(value => value ? '正确' : '错误');
  }
  function definiteAnswer(question) {
    if (question.status === 'needs_review' || question.warnings.length) throw new Error('题库答案存在冲突、缺失或待核对标记');
    if (question.type === 'true_false') {
      if (typeof question.answer.boolean !== 'boolean') throw new Error('判断题答案不明确');
      return { boolean: question.answer.boolean, texts: [String(question.answer.boolean)] };
    }
    if (!['single_choice', 'multiple_choice'].includes(question.type)) throw new Error('当前题型不支持自动选择');
    const labels = question.answer.labels;
    if (!labels.length || new Set(labels).size !== labels.length || (question.type === 'single_choice' && labels.length !== 1)) throw new Error('答案选项不明确');
    const texts = labels.map(label => {
      const found = question.options.filter(option => option.label === label && normalize(option.text));
      if (found.length !== 1) throw new Error('题库答案无法对应唯一选项');
      return normalize(found[0].text);
    });
    if (new Set(texts).size !== texts.length || (question.answer.texts.length &&
        [...question.answer.texts.map(normalize)].sort().join('|') !== [...texts].sort().join('|'))) throw new Error('题库答案文字不一致');
    return { boolean: null, texts };
  }
  function definiteCandidate(matches) {
    const best = matches[0];
    if (!best || !Number.isFinite(best.score) || best.score < 0.6) throw new Error(`首项匹配分${best ? ` ${(best.score * 100).toFixed(2)}` : '不足'}，低于 60，已停止`);
    const answer = definiteAnswer(best.question);
    for (const rival of matches.slice(1)) {
      if (best.score - rival.score > 0.06) continue;
      const other = definiteAnswer(rival.question);
      if (normalize(rival.question.question) !== normalize(best.question.question)
          || [...answer.texts].sort().join('|') !== [...other.texts].sort().join('|')) throw new Error('前几个匹配项接近且答案或题干不同，答案不确定');
    }
    return { best, answer };
  }
  function planAutoAnswer(matches, pageOptions) {
    const { best, answer } = definiteCandidate(matches);
    if (answer.boolean !== null) {
      if (pageOptions.length !== 2) throw new Error('判断题的页面选项数量不明确');
      const values = pageOptions.map(booleanAnswer);
      if (values.some(x => x === null) || new Set(values).size !== 2) throw new Error('无法区分页面中的正确/错误选项');
      return { indices: [values.indexOf(answer.boolean)], score: best.score, question: best.question };
    }
    const bankOptions = best.question.options.map(option => normalize(option.text)), actual = pageOptions.map(normalize);
    if (actual.length !== bankOptions.length || actual.length < 2 || actual.some(x => !x)
        || new Set(actual).size !== actual.length || new Set(bankOptions).size !== bankOptions.length
        || actual.some(text => !bankOptions.includes(text))) throw new Error('页面选项与题库不能逐一对应，答案不确定');
    return { indices: answer.texts.map(text => actual.indexOf(text)), score: best.score, question: best.question };
  }

  class AutoAnswerSession {
    constructor(adapter) { this.adapter = adapter; this.enabled = false; this.phase = 'stopped'; this.serial = 0; this.cleanup = null; this.handled = new Set(); }
    update(message) { this.adapter.update(message, this); }
    release() { this.cleanup?.(); this.cleanup = null; }
    start(unit) { this.release(); this.serial++; this.enabled = true; this.phase = 'waiting'; this.unit = unit; this.handled.clear(); this.update('自动选择已开启，正在识别当前题目…'); }
    stop(reason = '已停止自动选择') { this.release(); this.serial++; this.enabled = false; this.phase = 'stopped'; this.update(reason); }
    poll() {
      if (!this.enabled) return false;
      const current = this.adapter.current();
      if (current.unit !== this.unit) { this.stop('已离开当前单元，自动选择停止'); return true; }
      if (this.phase === 'selected') {
        if (current.identity && current.identity !== this.context.identity) {
          if (this.handled.has(current.identity)) { this.stop('当前题已选择过，停止以避免覆盖已有选项'); return true; }
          this.release(); this.phase = 'waiting'; this.adapter.next(); this.update('已检测到切题，等待下一题稳定…'); return false;
        }
        return true;
      }
      if (this.phase === 'selecting') {
        try { this.adapter.verify(this.context, this.plan, false); }
        catch (error) { this.stop(error.message || String(error)); }
        return true;
      }
      if (!current.signature) { this.stop('没有可识别的当前题目，已停止自动选择'); return true; }
      return false;
    }
    async accept(context) {
      if (!this.enabled || this.phase !== 'waiting') return;
      const serial = this.serial;
      try {
        this.plan = await this.adapter.plan(context, () => this.enabled && this.serial === serial);
        if (!this.enabled || serial !== this.serial) return;
        if (this.handled.has(context.identity)) throw new Error('当前题已选择过，不能重复选择');
        this.context = context; this.phase = 'selecting';
        this.adapter.verify(context, this.plan, false);
        this.cleanup = this.adapter.guard(context, () => this.stop('检测到手动改选，已停止自动选择；保留你的选择'));
        this.update('已匹配明确答案，正在勾选页面选项…');
        await this.adapter.choose(context, this.plan, () => this.enabled && this.serial === serial);
        if (!this.enabled || serial !== this.serial) return;
        this.adapter.verify(context, this.plan, true);
        this.phase = 'selected'; this.handled.add(context.identity);
        const selectedText = this.plan.question.type === 'true_false'
          ? (this.plan.question.answer.boolean ? '正确（✓）' : '错误（×）')
          : this.plan.indices.map(i => String.fromCharCode(65 + i)).join('、');
        this.update(`已选 ${selectedText}。请手动点击网页“提交”；切到下一题后继续识别。`);
      } catch (error) { if (this.enabled && serial === this.serial) this.stop(error.message || String(error)); }
    }
  }

  let workerPromise = null;
  function deadline(promise, milliseconds, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })])
      .finally(() => clearTimeout(timer));
  }
  function getOCRWorker() {
    if (typeof Tesseract === 'undefined' || typeof Tesseract.createWorker !== 'function') throw new Error('新版 OCR 依赖未加载，请保存脚本并刷新页面');
    if (!workerPromise) workerPromise = Tesseract.createWorker(['chi_sim', 'eng'], 1, {
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
      logger: progress => {
        if (state.busy && state.epoch === state.ocrEpoch) status(`OCR：${progress.status || '加载中'} ${Math.round((progress.progress || 0) * 100)}%`);
      }
    }).then(async worker => {
      try {
        await worker.setParameters({ preserve_interword_spaces: '0', user_defined_dpi: '300', tessedit_pageseg_mode: '3' });
        return worker;
      } catch (error) { await worker.terminate(); throw error; }
    });
    return workerPromise;
  }
  function warmOCR() {
    try {
      const pending = getOCRWorker();
      pending.catch(() => { if (workerPromise === pending) workerPromise = null; });
    } catch (_) { /* 依赖加载失败时，用户点击识别后显示错误。 */ }
  }
  function ocrImageSize(width, height, detailed = false) {
    const desiredScale = detailed ? Math.min(2, Math.max(1, 1800 / width)) : (width < 900 ? Math.min(2, 1200 / width) : 1);
    const scale = Math.min(desiredScale, detailed ? 3 : 2200 / width,
      Math.sqrt((detailed ? 12000000 : 3500000) / (width * height)));
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  }
  function resizeOCRImage(image, detailed = false) {
    const size = ocrImageSize(image.width, image.height, detailed);
    if (size.width === image.width && size.height === image.height) return image;
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  async function runOCR(image, epoch) {
    const started = performance.now(), pending = getOCRWorker();
    state.ocrEpoch = epoch;
    try {
      const worker = await deadline(pending, 90000, 'OCR 引擎加载超时，请检查语言包网络连接');
      if (state.epoch !== epoch) return { text: '' };
      let sent = resizeOCRImage(image), retried = false;
      showPreview(sent, ui.source.textContent.replace(/^本次识别来源：/, '').replace(/ · \d+×\d+$/, ''));
      // 只需要 text 和置信度，省去布局、HTML、TSV 等输出的序列化。
      let { data } = await deadline(worker.recognize(sent, {tessedit_pageseg_mode:'3'}, { text: true, blocks: false, hocr: false, tsv: false }), 60000, 'OCR 识别超时，请只截取题目区域后重试');
      if (state.epoch !== epoch) return data;
      const best = state.index?.search(data.text || '', 1)[0];
      if (!best || best.score < 0.5 || data.confidence < 60) {
        const detailed = resizeOCRImage(image, true);
        if (detailed.width !== sent.width || detailed.height !== sent.height) {
          status('快速识别匹配较弱，正在用较高清晰度复核…');
          const retry = await deadline(worker.recognize(detailed, {tessedit_pageseg_mode:'3'}, { text: true, blocks: false, hocr: false, tsv: false }), 60000, '高清复核超时，请裁剪题目区域后重试');
          const retryScore = state.index?.search(retry.data.text || '', 1)[0]?.score || 0;
          if (retryScore > (best?.score || 0) || (retryScore === (best?.score || 0) && retry.data.confidence > data.confidence)) {
            data = retry.data; sent = detailed;
          }
          retried = true;
        }
      }
      if (state.epoch === epoch) showPreview(sent, ui.source.textContent.replace(/^本次识别来源：/, '').replace(/ · \d+×\d+$/, ''));
      return { ...data, elapsedMs: performance.now() - started, retried };
    } catch (error) {
      if (workerPromise === pending) workerPromise = null;
      pending.then(worker => worker.terminate()).catch(() => {});
      throw error;
    }
  }

  function showPreview(canvas, source) {
    ui.previewCanvas = canvas;
    ui.preview.hidden = false;
    ui.previewLabel.textContent = `查看送入 OCR 的图片 · ${source}`;
    ui.source.textContent = `本次识别来源：${source} · ${canvas.width}×${canvas.height}`;
    if (ui.preview.open) updatePreviewImage();
  }
  function updatePreviewImage() {
    const canvas = ui.previewCanvas;
    if (!canvas || ui.encodedCanvas === canvas) return;
    ui.encodedCanvas = canvas;
    canvas.toBlob(blob => {
      if (!blob || ui.previewCanvas !== canvas) return;
      if (ui.previewURL) URL.revokeObjectURL(ui.previewURL);
      ui.previewURL = URL.createObjectURL(blob); ui.previewImage.src = ui.previewURL;
    }, 'image/png');
  }

  async function screenshotCanvas(file) {
    if (file.size > 20 * 1024 * 1024) throw new Error('截图超过 20 MB，请裁剪到题目区域');
    const url = URL.createObjectURL(file), img = new Image();
    try {
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('无法读取截图，请选择 PNG、JPEG 或 WebP 图片')); img.src = url; });
      const width = img.naturalWidth, height = img.naturalHeight;
      if (width * height > 24000000) throw new Error('截图像素过多，请只截取题目区域');
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); ctx.drawImage(img, 0, 0, width, height);
      return canvas;
    } finally { URL.revokeObjectURL(url); }
  }

  async function recognizeScreenshot(file) {
    if (!file) return;
    if (state.busy || capturePending) { status('正在识别或等待共享授权，请完成后再拖入或粘贴图片'); return; }
    if (!state.index) { status('请先导入 JSON 题库'); return; }
    if (autoAnswer?.enabled) autoAnswer.stop('已导入手动截图，停止自动选择；截图结果仅用于展示');
    const epoch = ++state.epoch;
    state.busy = true; ui.ocr.disabled = true; ui.imageButton.disabled = true;
    warmOCR();
    clearResults('正在识别截图…'); status('正在读取截图…');
    try {
      const canvas = await screenshotCanvas(file); showPreview(canvas, `导入图片：${file.name}`);
      const data = await runOCR(canvas, epoch);
      if (state.epoch !== epoch) return;
      const text = String(data?.text || '').trim();
      if (normalize(text).length < 2) throw new Error('截图未识别到文字，请裁剪清晰的题目区域');
      // 导入的截图属于手动查询，固定当前页面指纹，避免自动任务马上覆盖。
      const signature = fingerprint(findQuestion()); state.fingerprint = signature; state.stable = signature;
      ui.query.value = text; renderResults(text);
      status(`截图识别完成${Number.isFinite(data.elapsedMs) ? ` · ${(data.elapsedMs / 1000).toFixed(1)} 秒${data.retried ? '（含高清复核）' : ''}` : ''}${Number.isFinite(data.confidence) ? ` · OCR 置信度 ${Math.round(data.confidence)}` : ''}。请核对候选题目。`);
    } catch (error) {
      if (state.epoch === epoch) { clearResults('截图识别失败，可手动输入关键词检索。'); status(error.message || String(error)); }
    } finally { state.busy = false; ui.ocr.disabled = false; ui.imageButton.disabled = false; ui.imageFile.value = ''; }
  }

  function transferHasFiles(transfer) {
    return Boolean(transfer && (Array.from(transfer.types || []).includes('Files')
      || transfer.files?.length || Array.from(transfer.items || []).some(item => item.kind === 'file')));
  }
  function transferFiles(transfer) {
    const files = Array.from(transfer?.files || []);
    return files.length ? files : Array.from(transfer?.items || [])
      .filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  }
  function bindScreenshotInput(target, onImage, onMessage) {
    let dragDepth = 0;
    const reset = () => { dragDepth = 0; target.classList.remove('image-drop'); };
    const accept = files => {
      if (files.length !== 1) { onMessage('请一次拖入或粘贴一张题目截图'); return; }
      const file = files[0];
      if (!/^image\/(png|jpeg|webp)$/i.test(file.type || '')
          && !(!file.type && /\.(png|jpe?g|webp)$/i.test(file.name || ''))) {
        onMessage('请选择 PNG、JPEG 或 WebP 图片；文字请直接输入或粘贴'); return;
      }
      void onImage(file);
    };
    target.addEventListener('dragenter', event => {
      if (!transferHasFiles(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); dragDepth++;
      target.classList.add('image-drop');
    });
    target.addEventListener('dragover', event => {
      if (!transferHasFiles(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
    });
    target.addEventListener('dragleave', event => {
      if (!dragDepth) return;
      event.stopPropagation(); if (--dragDepth === 0) reset();
    });
    target.addEventListener('drop', event => {
      if (!transferHasFiles(event.dataTransfer)) { reset(); return; }
      event.preventDefault(); event.stopPropagation(); reset();
      accept(transferFiles(event.dataTransfer));
    });
    target.addEventListener('paste', event => {
      // 普通文本保留 textarea 的默认粘贴行为；图片直接进入同一 OCR 流程。
      if (!transferHasFiles(event.clipboardData)) return;
      event.preventDefault(); event.stopPropagation();
      accept(transferFiles(event.clipboardData));
    });
  }

  let captureStream = null, captureVideo = null;
  let capturePending = false;
  async function toggleCapture() {
    if (capturePending) return;
    if (captureStream) { stopCapture(); status('已停止真实画面识别'); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { status('浏览器不支持标签页画面读取，请使用“导入截图识别”'); return; }
    capturePending = true; state.epoch++; ui.capture.disabled = true;
    warmOCR();
    status('请在浏览器弹窗中选择当前习题标签页并点击共享；授权完成后按钮会变为“停止画面读取”。');
    try {
      // 必须由用户点击触发，并由浏览器弹窗选择当前标签页。
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include'
      });
      const track = stream.getVideoTracks()[0];
      if (track.getSettings().displaySurface !== 'browser') {
        stream.getTracks().forEach(t => t.stop()); throw new Error('请选择当前浏览器标签页；窗口或整个屏幕无法准确定位题目');
      }
      captureStream = stream;
      captureVideo = document.createElement('video'); captureVideo.muted = true; captureVideo.srcObject = stream;
      await deadline(captureVideo.play(), 15000, '共享视频未能启动，请尝试导入系统截图');
      track.addEventListener('ended', () => {
        if (captureStream !== stream) return;
        stopCapture(); status('标签页共享已结束；已停止自动截图，请重新开启共享或导入系统截图');
      }, { once: true });
      ui.capture.textContent = '停止画面读取';
      ui.captureState.textContent = '共享状态：已连接标签页画面（请确认选中的是当前页）';
      state.epoch++; state.fingerprint = ''; state.attempt = ''; state.stable = '';
      status('真实画面读取已开启。请确认共享的是当前标签页，并让整道题显示在视口内。');
    } catch (error) { stopCapture(); status(`画面读取未开启：${error.message || error}。也可导入题目截图。`); }
    finally { capturePending = false; ui.capture.disabled = false; }
  }
  function stopCapture() {
    if (autoAnswer?.enabled) autoAnswer.stop('画面共享已停止，自动选择停止');
    captureStream?.getTracks().forEach(t => t.stop());
    if (captureVideo) { captureVideo.pause(); captureVideo.srcObject = null; }
    captureStream = null; captureVideo = null;
    state.epoch++; state.fingerprint = ''; state.attempt = '';
    if (ui) {
      ui.capture.textContent = '开启真实画面识别';
      ui.captureState.textContent = '共享状态：未连接。防复制页面请开启共享，或导入系统截图。';
    }
  }
  async function capturePixels(target) {
    const video = captureVideo;
    if (!video || !captureStream?.active || !video.videoWidth) throw new Error('标签页共享已中断，请重新开启真实画面识别');
    const rect = questionViewportRect(target), { left, top } = rect;
    if (left < -2 || top < -2 || left + rect.width > innerWidth + 2 || top + rect.height > innerHeight + 2) {
      throw new Error('题目没有完整显示，请调整滚动位置或缩小页面，再识别；也可导入完整题目截图');
    }
    const sx = video.videoWidth / innerWidth, sy = video.videoHeight / innerHeight;
    const sourceWidth = rect.width * sx, sourceHeight = rect.height * sy;
    const scale = Math.min(1, Math.sqrt(24000000 / Math.max(1, sourceWidth * sourceHeight)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale)); canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    // 避免助手窗口挡住题目；等待共享视频更新后截取，不改变题目本身。
    const previous = host.style.visibility;
    host.style.setProperty('visibility', 'hidden', 'important');
    try {
      await new Promise(resolve => setTimeout(resolve, 220));
      if (captureVideo !== video || !captureStream?.active) throw new Error('共享已停止');
      canvas.getContext('2d').drawImage(video, Math.max(0, left) * sx, Math.max(0, top) * sy, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    } finally {
      if (previous) host.style.setProperty('visibility', previous, 'important'); else host.style.removeProperty('visibility');
    }
    return canvas;
  }

  const state = { index: null, busy: false, auto: true, epoch: 0, fingerprint: '', stable: '', seenAt: 0, attempt: '', attemptAt: 0 };
  let host, ui, autoAnswer = null;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function status(message) { ui.status.textContent = message; }
  function visible(node) {
    const view = node.ownerDocument.defaultView, style = view.getComputedStyle(node), rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 5 && rect.height > 5
      && rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
  }
  function sameDocument(a, b) {
    // 用户脚本沙箱中的 Window/Document 代理不一定与 DOM 返回对象严格相等。
    if (a === b) return true;
    return Boolean(a?.documentElement && b?.documentElement
      && (a.documentElement === b.documentElement || a.documentElement.isSameNode?.(b.documentElement)));
  }
  function documentContexts(root = document) {
    const contexts = [{ doc: root, frames: [] }];
    for (const context of contexts) for (const frame of context.doc.querySelectorAll('iframe')) {
      if (!visible(frame)) continue;
      try {
        const child = frame.contentDocument;
        if (child?.body && !contexts.some(context => sameDocument(context.doc, child))) {
          contexts.push({ doc: child, frames: [...context.frames, { frame, doc: child }] });
        }
      } catch (_) { /* 跨域 iframe 无法访问 */ }
    }
    return contexts;
  }
  function documents() { return documentContexts().map(context => context.doc); }
  function mapFrameRect(rect, outer, metrics) {
    const scaleX = outer.width / Math.max(1, metrics.offsetWidth);
    const scaleY = outer.height / Math.max(1, metrics.offsetHeight);
    const contentScaleX = scaleX * metrics.clientWidth / Math.max(1, metrics.viewportWidth);
    const contentScaleY = scaleY * metrics.clientHeight / Math.max(1, metrics.viewportHeight);
    return {
      left: outer.left + metrics.clientLeft * scaleX + rect.left * contentScaleX,
      top: outer.top + metrics.clientTop * scaleY + rect.top * contentScaleY,
      width: rect.width * contentScaleX, height: rect.height * contentScaleY
    };
  }
  function questionViewportRect(target, root = document) {
    const targetDoc = target.ownerDocument;
    const path = sameDocument(targetDoc, root) ? []
      : documentContexts(root).find(context => sameDocument(context.doc, targetDoc))?.frames;
    if (!path) throw new Error('题目 iframe 已变化或不可访问，请重新打开题目后识别');
    const raw = target.getBoundingClientRect();
    let rect = { left: raw.left, top: raw.top, width: raw.width, height: raw.height };
    // 从最内层往外映射，使用实际查找到的 iframe 元素，不依赖 window.frameElement。
    for (const { frame, doc } of [...path].reverse()) {
      if (!frame.isConnected || !sameDocument(frame.contentDocument, doc)) throw new Error('题目 iframe 正在切换，请稍后重新识别');
      const viewportWidth = doc.defaultView?.innerWidth || frame.clientWidth;
      const viewportHeight = doc.defaultView?.innerHeight || frame.clientHeight;
      if (rect.left < -2 || rect.top < -2 || rect.left + rect.width > viewportWidth + 2 || rect.top + rect.height > viewportHeight + 2) {
        throw new Error('题目在 iframe 内未完整显示，请调整题目区域的滚动位置或导入截图');
      }
      rect = mapFrameRect(rect, frame.getBoundingClientRect(), {
        offsetWidth: frame.offsetWidth, offsetHeight: frame.offsetHeight,
        clientWidth: frame.clientWidth, clientHeight: frame.clientHeight,
        clientLeft: frame.clientLeft, clientTop: frame.clientTop, viewportWidth, viewportHeight
      });
    }
    return rect;
  }
  function findQuestion() {
    const selectors = ['.item-type', '.problem-content', '.question-content', '.problem-main', '.problem-body', '.question-body', '.item-body', '.container-problem'];
    for (const doc of documents()) for (const selector of selectors) {
      const candidates = [...doc.querySelectorAll(selector)].map(n => selector === '.item-type' ? n.parentElement : n).filter(n => n && visible(n) && !host.contains(n));
      if (candidates.length) {
        // 多题同屏时识别最接近视口中心的一题，不切题或滚动页面。
        candidates.sort((a, b) => {
          const center = doc.defaultView.innerHeight / 2, ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return Math.abs((ra.top + ra.bottom) / 2 - center) - Math.abs((rb.top + rb.bottom) / 2 - center);
        });
        return candidates[0];
      }
    }
    return null;
  }
  function fingerprint(root) {
    if (!root) return '';
    const images = [...root.querySelectorAll('img')].map(img => `${img.currentSrc || img.src}:${img.complete}:${img.naturalWidth}`).join('|');
    const canvases = [...root.querySelectorAll('canvas')].map(canvas => {
      try { return canvas.toDataURL(); } catch (_) { return `${canvas.width}x${canvas.height}`; }
    }).join('|');
    return `${location.href}\n${root.innerText}\n${images}\n${canvases}`;
  }
  function unitKey() { return `${location.origin}${location.pathname}?node_id=${new URLSearchParams(location.search).get('node_id') || ''}`; }
  function pageOptions(root) {
    const list = root.querySelector('.list-unstyled-radio, ul.list, [class*="option-list"], [class*="answer-list"], [role="radiogroup"], .list-unstyled, ul');
    const selector = 'li, .option-item, .answer-item, label.el-radio, label.el-checkbox, [role="radio"], [role="checkbox"]';
    const all = [...(list || root).querySelectorAll(selector)].filter(node => visible(node));
    const nodes = all.filter(node => !all.some(other => other !== node && other.contains(node)));
    if (nodes.length < 2 || nodes.length > 8) throw new Error('未找到数量明确的页面选项，已停止');
    return nodes;
  }
  function optionSelected(node) {
    const input = node.matches('input') ? node : node.querySelector('input[type="radio"], input[type="checkbox"]');
    if (input) return input.checked;
    const aria = node.getAttribute('aria-checked') ?? node.querySelector('[aria-checked]')?.getAttribute('aria-checked');
    if (aria !== null && aria !== undefined) return aria === 'true';
    return [node, ...node.querySelectorAll('.is-checked, .is-selected, .selected, .checked, .active')]
      .some(element => /(?:^|\s)(?:is-checked|is-selected|selected|checked|active)(?:\s|$)/.test(element.className || ''));
  }
  function controlDisabled(node) {
    return Boolean(node.matches(':disabled, [aria-disabled="true"], .is-disabled, .disabled') || node.querySelector('input:disabled'));
  }
  function questionIdentity(root) {
    if (!root) return '';
    const nodes = pageOptions(root), body = normalize(root.innerText), options = nodes.map(node => normalize(node.innerText));
    const start = options[0] ? body.indexOf(options[0]) : -1;
    // 不包含选项后的作答反馈，手动提交后等待真正切题，不重新覆盖当前题。
    return `${unitKey()}|${start >= 0 ? body.slice(0, start) : body}|${options.join('|')}`;
  }
  function verifyAutoContext(context, plan, requireSelection) {
    if (document.hidden) throw new Error('页面已转入后台，自动选择停止');
    if (unitKey() !== context.unit || !context.target.isConnected || fingerprint(context.target) !== context.signature
        || findQuestion() !== context.target) throw new Error('当前题目已变化，已停止自动选择');
    const currentOptions = pageOptions(context.target);
    if (currentOptions.length !== context.nodes.length || currentOptions.some((node, i) => node !== context.nodes[i] || controlDisabled(node))) throw new Error('页面选项已变化或不可操作，已停止');
    if (requireSelection) {
      if (context.nodes.some((node, i) => optionSelected(node) !== plan.indices.includes(i))) throw new Error('选中状态与题库答案不一致，已停止自动选择');
    }
  }
  function createAutoSession() {
    return new AutoAnswerSession({
      current: () => {
        const target = findQuestion(); let identity = '';
        try { if (target) identity = questionIdentity(target); } catch (_) { /* 手动提交后的切题过渡可能暂时没有选项。 */ }
        return { unit: unitKey(), signature: fingerprint(target), identity };
      },
      next: () => { state.fingerprint = ''; state.stable = ''; state.attempt = ''; },
      update: (message, session) => {
        ui.autoAnswerButton.textContent = session.enabled ? '停止自动选择' : '自动选择选项';
        ui.autoAnswerStatus.textContent = message;
      },
      plan: async (context, active) => {
        const { best } = definiteCandidate(context.matches);
        if (Number.isFinite(context.confidence) && context.confidence < 60) throw new Error('OCR 置信度过低，答案不确定，已停止');
        definiteAnswer(best.question);
        context.nodes = pageOptions(context.target); context.identity = questionIdentity(context.target);
        if (best.question.type === 'true_false') {
          const values = context.nodes.map(booleanOptionValue);
          const optionTexts = values.length === 2 && values.every(value => value !== null) && new Set(values).size === 2
            ? values.map(value => value ? '正确' : '错误')
            : recognizedBooleanOptions(context.text, context.nodes.length);
          return planAutoAnswer(context.matches, optionTexts);
        }
        const isCheckbox = context.nodes.some(node => node.matches('[role="checkbox"], .el-checkbox') || node.querySelector('input[type="checkbox"], [role="checkbox"], .el-checkbox'));
        if (best.question.type === 'multiple_choice' && !isCheckbox) throw new Error('多选题页面控件类型不明确，已停止');
        if (best.question.type === 'single_choice' && isCheckbox) throw new Error('页面题型与题库不一致，已停止');
        const strategies = [
          () => context.nodes.map(node => stripOptionLabel(node.innerText)),
          () => parseRecognizedOptions(context.text, context.nodes.length),
          () => optionsByTextOrder(context.text, best.question.options)
        ];
        let lastError;
        for (const read of strategies) {
          try { return planAutoAnswer(context.matches, read()); } catch (error) { lastError = error; }
        }
        if (!captureStream?.active) throw new Error(`${lastError?.message || '选项不明确'}；请共享当前标签页后逐项识别`);
        // 整题 OCR 可能把方框或 B/8 混淆；按每个实际控件的坐标单独识别文字。
        const worker = await deadline(getOCRWorker(), 90000, 'OCR 引擎未就绪');
        const readings = [];
        for (let i = 0; i < context.nodes.length; i++) {
          if (!active()) throw new Error('自动选择已停止');
          verifyAutoContext(context, null, false);
          autoAnswer.update(`正在逐项核对选项 ${i+1}/${context.nodes.length}…`);
          const node = context.nodes[i], style = node.ownerDocument.defaultView.getComputedStyle(node);
          const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.5;
          const mode = node.getBoundingClientRect().height > lineHeight * 1.8 ? '6' : '7';
          const rect = optionTextRect(node);
          const pixels = await capturePixels({ownerDocument:node.ownerDocument,getBoundingClientRect:()=>rect});
          const image = resizeOptionImage(pixels, (parseFloat(style.fontSize) || 16) * pixels.width / rect.width);
          const {data} = await deadline(worker.recognize(image, {tessedit_pageseg_mode:mode}, {text:true,blocks:false,hocr:false,tsv:false}), 30000, '逐项识别超时');
          if (!active()) throw new Error('自动选择已停止');
          if (Number.isFinite(data.confidence) && data.confidence < 60) throw new Error(`第 ${i+1} 个选项 OCR 置信度不足，已停止；请手动核对`);
          try { readings.push(identifyOptionText(data.text, best.question.options)); }
          catch (_) { throw new Error(`第 ${i+1} 个页面选项识别为“${String(data.text || '').trim()}”，与题库不能唯一对应，已停止`); }
        }
        verifyAutoContext(context, null, false);
        return planAutoAnswer(context.matches, readings);
      },
      verify: verifyAutoContext,
      guard: (context, cancel) => {
        const docs = [...new Set([document, context.target.ownerDocument])];
        const listener = event => {
          if (!event.isTrusted) return;
          if ((event.type === 'keydown' && event.key === 'Escape') || context.nodes.some(node => node.contains(event.target))) cancel();
        };
        // input.click() 的默认行为也会产生 trusted change，不能把它误判为人工操作。
        for (const doc of docs) for (const name of ['pointerdown', 'keydown']) doc.addEventListener(name, listener, true);
        return () => { for (const doc of docs) for (const name of ['pointerdown', 'keydown']) doc.removeEventListener(name, listener, true); };
      },
      choose: async (context, plan, active) => {
        for (let i = 0; i < context.nodes.length; i++) {
          if (!active()) return;
          verifyAutoContext(context, plan, false);
          const node = context.nodes[i], wanted = plan.indices.includes(i), selected = optionSelected(node);
          if (selected === wanted) continue;
          if (!wanted && plan.question.type !== 'multiple_choice') continue;
          const control = node.querySelector('label.el-radio, label.el-checkbox, [role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]') || node;
          control.click();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    });
  }
  async function toggleAutoAnswer() {
    if (autoAnswer.enabled) { autoAnswer.stop('已手动停止自动选择；已选中的选项保留'); return; }
    if (state.busy || capturePending) { ui.autoAnswerStatus.textContent = '请等待当前识别或共享授权完成，再开始自动选择'; return; }
    if (!state.index) { autoAnswer.stop('请先导入题库'); return; }
    const target = findQuestion();
    if (!target) { autoAnswer.stop('请先打开当前单元的题目'); return; }
    if (!captureStream?.active && !trustedPageText(state.index, target.innerText || '')) {
      ui.autoAnswerStatus.textContent = '页面有防复制文字，请在弹窗中共享当前标签页';
      await toggleCapture();
      if (!captureStream?.active) { autoAnswer.stop('未连接真实画面共享，自动选择未启动'); return; }
    }
    state.auto = true; ui.auto.checked = true;
    state.fingerprint = ''; state.stable = ''; state.attempt = '';
    autoAnswer.start(unitKey());
    void recognize(true);
  }
  function clearResults(message) { ui.results.replaceChildren(element('p', message, 'hint')); }
  function renderResults(text) {
    state.epoch++;
    if (!state.index) { clearResults('请先导入 question_bank.json。'); return; }
    if (normalize(text).length < 2) { clearResults('请输入至少两个字，或识别当前题目。'); return; }
    const matches = state.index.search(text);
    ui.results.replaceChildren();
    if (!matches.length) { clearResults('未找到相关题目。可修正 OCR 文本，或输入有区分度的关键词。'); return; }
    const close = matches.length > 1 && matches[0].score - matches[1].score < 0.06;
    ui.results.append(element('p', `${matches.length} 个候选 · 匹配分仅用于排序${close ? ' · 前几项接近，请结合选项核对' : ''}`, 'hint'));
    const warningNames = { conflicting_answers: '来源答案冲突', missing_answer: '原题缺答案', answer_option_not_found: '答案选项缺失', missing_options: '选项缺失', inline_answer_conflict: '行内答案冲突', unrecognized_choice_answer: '答案格式待核对' };
    matches.forEach((match, i) => {
      const q = match.question, card = element('article', undefined, 'card');
      card.append(element('div', `${i + 1}. ${types[q.type]} · 匹配分 ${Math.round(match.score * 100)} / 100 · ${match.matchReason}`, 'meta'), element('h3', q.question));
      const list = element('div', undefined, 'options');
      q.options.forEach(o => list.append(element('div', `${o.label}. ${o.text}`)));
      const answer = element('div', undefined, 'answer'), labels = q.answer.labels.join('、');
      let answerText = q.answer.texts.join('；');
      if (!answerText && q.answer.boolean !== null) answerText = q.answer.boolean ? '正确' : '错误';
      answer.append(element('strong', `题库答案：${labels || answerText || q.answer.raw || '未提供'}`));
      if (labels && answerText) answer.append(element('div', answerText));
      card.append(answer, list);
      if (q.explanation) card.append(element('p', `解析：${q.explanation}`));
      if (q.status === 'needs_review' || q.warnings.length) card.append(element('p', `待核对：${q.warnings.map(w => warningNames[w] || w).join('、') || '题库已标记待核对'}`, 'warning'));
      if (match.score < 0.5) card.append(element('p', '匹配较弱，请核对题干、否定词及选项。', 'warning'));
      const sources = [...new Set(q.sources.map(s => `${s.file.split(/[\\/]/).pop()}${s.line_start ? `:${s.line_start}` : ''}${s.chapter ? ` · ${s.chapter}` : ''}`))];
      if (sources.length) card.append(element('div', `来源：${sources.join('；')}`, 'source'));
      ui.results.append(card);
    });
  }

  async function recognize(manual = false) {
    if (state.busy || capturePending) return;
    if (autoAnswer?.enabled && autoAnswer.phase !== 'waiting') return;
    const autoSerial = autoAnswer?.enabled ? autoAnswer.serial : null;
    if (!state.index) { status('请先导入 JSON 题库'); return; }
    const target = findQuestion();
    if (!target) { status('未找到可见题目。请打开题目页面，或手动粘贴关键词检索。'); if (autoAnswer?.enabled) autoAnswer.stop('当前题目不可见，自动选择停止'); return; }
    const signature = fingerprint(target);
    if (!manual && signature === state.fingerprint) return;
    if (!manual && signature === state.attempt && Date.now() - state.attemptAt < 30000) return;
    state.attempt = signature; state.attemptAt = Date.now();
    const epoch = ++state.epoch;
    state.busy = true; ui.ocr.disabled = true;
    ui.imageButton.disabled = true;
    clearResults('正在识别当前题目…'); status('正在读取题目文字…');
    try {
      const pageText = String(target.innerText || '').trim();
      let text, confidence = null, elapsedMs = null, method = '页面文字';
      if (!captureStream?.active && trustedPageText(state.index, pageText)) {
        text = pageText; ui.preview.hidden = true; ui.source.textContent = '本次识别来源：题库交叉核对后的页面文字';
      } else {
        if (!captureStream?.active) {
          // 字体映射页面不能重绘 DOM：必须取得真实像素，不能静默回退。
          ui.preview.hidden = true;
          ui.source.textContent = '本次未执行 OCR：页面文字不可信，且尚未连接标签页共享。';
          clearResults('请点击“开启真实画面识别”，授权共享当前标签页；或用系统截图工具截取题目，再点击“导入截图识别”。');
          status('需要真实截图。按钮变为“停止画面读取”才表示共享成功；取消、失败或刷新后需要重新开启。');
          state.fingerprint = signature; state.stable = signature;
          if (autoAnswer?.enabled) autoAnswer.stop('需要真实画面共享，自动选择停止');
          return;
        }
        if ([...target.querySelectorAll('img')].some(img => !img.complete)) throw new Error('题目图片尚未加载，稍后重试');
        ui.source.textContent = '本次识别来源：标签页共享已连接，正在定位题目区域';
        status('正在读取标签页真实画面…');
        const canvas = await capturePixels(target);
        if (canvas.width * canvas.height > 24000000) throw new Error('题目截图过大，请缩小浏览器窗口后重试');
        showPreview(canvas, '浏览器共享的标签页真实画面');
        const data = await runOCR(canvas, epoch);
        text = String(data?.text || '').trim(); confidence = data?.confidence; elapsedMs = data?.elapsedMs; method = '真实画面 OCR';
      }
      if (state.epoch !== epoch) return;
      if (!target.isConnected || fingerprint(target) !== signature || (!manual && !state.auto)) {
        if (autoAnswer?.enabled) autoAnswer.stop('识别期间题目已变化，自动选择停止');
        clearResults('页面题目已变化，等待重新识别。'); status('已丢弃过期 OCR 结果'); return;
      }
      if (normalize(text).length < 2) throw new Error('OCR 未识别到有效文字，请手动输入关键词');
      state.fingerprint = signature; state.stable = signature; state.seenAt = Date.now(); ui.query.value = text;
      const best = state.index.search(text, 1)[0];
      renderResults(text);
      status(best && best.score >= 0.5
        ? `${method}检索完成${Number.isFinite(elapsedMs) ? ` · ${(elapsedMs / 1000).toFixed(1)} 秒` : ''}${Number.isFinite(confidence) ? ` · OCR 置信度 ${Math.round(confidence)}` : ''}。请核对题干和选项文字。`
        : '识别文字未能可靠匹配题库。若页面有防复制字体，请开启真实画面识别，或导入题目截图；也可输入选项中的连续关键词。');
      if (autoAnswer?.enabled && autoAnswer.serial === autoSerial) {
        await autoAnswer.accept({ target, signature, unit: unitKey(), text, confidence, matches: state.index.search(text) });
      }
    } catch (error) {
      if (autoAnswer?.enabled && autoAnswer.serial === autoSerial) autoAnswer.stop(`识别或选项处理失败：${error.message || error}`);
      if (state.epoch === epoch) { clearResults('识别失败，可手动输入关键词检索。'); status(`OCR 失败：${error.message || error}`); }
    } finally { state.busy = false; ui.ocr.disabled = false; ui.imageButton.disabled = false; }
  }

  async function importBank(file) {
    if (!file) return;
    if (autoAnswer?.enabled) autoAnswer.stop('题库正在更换，自动选择停止');
    state.epoch++; ui.importButton.disabled = true; status('正在校验题库…');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，请拆分题库');
      const questions = validateBank(JSON.parse((await file.text()).replace(/^\uFEFF/, ''))), nextIndex = new QuestionIndex(questions);
      // 持久化成功后再替换内存题库，失败时保留旧题库。
      await GM_setValue(KEYS.bank, { name: file.name, questions });
      state.index = nextIndex; state.fingerprint = ''; state.attempt = '';
      ui.bank.textContent = `${file.name} · ${questions.length} 道题`;
      renderResults(ui.query.value);
      status(`导入成功：${questions.length} 道题。${state.auto ? '打开题目后自动 OCR。' : '可点击“识别当前题目”。'}`);
      if (state.auto) warmOCR();
    } catch (error) { status(`导入失败：${error.message || error}`); }
    finally { ui.importButton.disabled = false; ui.file.value = ''; }
  }

  function fitPanelGeometry(value, viewportWidth, viewportHeight, collapsedHeight = null) {
    const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    const maxWidth = Math.max(1, viewportWidth - 16), maxHeight = Math.max(1, viewportHeight - 16);
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const width = clamp(number(value?.width, 440), Math.min(320, maxWidth), maxWidth);
    const height = clamp(number(value?.height, Math.min(720, viewportHeight * 0.88)), Math.min(240, maxHeight), maxHeight);
    const left = clamp(number(value?.left, viewportWidth - width - 16), 8, Math.max(8, viewportWidth - width - 8));
    const top = clamp(number(value?.top, 20), 8, Math.max(8, viewportHeight - (collapsedHeight ?? height) - 8));
    return { left, top, width, height };
  }

  function enablePanelGeometry(panel, header, resizeHandle, saved) {
    let geometry = fitPanelGeometry(saved, innerWidth, innerHeight), collapsed = false, gesture = null;
    let saveChain = Promise.resolve();
    const persist = () => {
      const snapshot = { ...geometry };
      saveChain = saveChain.catch(() => {}).then(() => GM_setValue(KEYS.window, snapshot))
        .catch(error => console.warn('窗口位置保存失败', error));
    };
    const apply = next => {
      geometry = fitPanelGeometry(next, innerWidth, innerHeight, collapsed ? header.getBoundingClientRect().height : null);
      host.style.setProperty('left', `${geometry.left}px`, 'important');
      host.style.setProperty('top', `${geometry.top}px`, 'important');
      host.style.setProperty('right', 'auto', 'important');
      panel.style.width = `${geometry.width}px`;
      panel.style.height = collapsed ? 'auto' : `${geometry.height}px`;
    };
    const begin = (event, mode) => {
      if (gesture || event.button !== 0 || event.isPrimary === false || (mode === 'resize' && collapsed)) return;
      if (mode === 'move' && event.target.closest('button, input, a')) return;
      event.preventDefault(); event.stopPropagation();
      gesture = { mode, pointer: event.pointerId, x: event.clientX, y: event.clientY, geometry: { ...geometry }, target: event.currentTarget };
      event.currentTarget.setPointerCapture(event.pointerId);
      panel.classList.add('adjusting');
    };
    const move = event => {
      if (!gesture || event.pointerId !== gesture.pointer) return;
      event.preventDefault(); event.stopPropagation();
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y, before = gesture.geometry;
      apply(gesture.mode === 'move' ? { ...before, left: before.left + dx, top: before.top + dy }
        : { ...before, width: Math.min(before.width + dx, innerWidth - before.left - 8), height: Math.min(before.height + dy, innerHeight - before.top - 8) });
    };
    const finish = event => {
      if (!gesture || event.pointerId !== gesture.pointer) return;
      const previous = gesture; gesture = null;
      panel.classList.remove('adjusting');
      if (previous.target.hasPointerCapture(previous.pointer)) previous.target.releasePointerCapture(previous.pointer);
      persist();
    };
    for (const [target, mode] of [[header, 'move'], [resizeHandle, 'resize']]) {
      target.addEventListener('pointerdown', event => begin(event, mode));
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', finish);
      target.addEventListener('pointercancel', finish);
      target.addEventListener('lostpointercapture', finish);
    }
    resizeHandle.addEventListener('keydown', event => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const delta = directions[event.key];
      if (!delta || collapsed) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 40 : 10;
      apply({ ...geometry, width: Math.min(geometry.width + delta[0] * step, innerWidth - geometry.left - 8),
        height: Math.min(geometry.height + delta[1] * step, innerHeight - geometry.top - 8) });
      persist();
    });
    window.addEventListener('resize', () => { apply(geometry); persist(); });
    apply(geometry);
    return {
      collapse() { collapsed = !collapsed; panel.classList.toggle('collapsed', collapsed); apply(geometry); persist(); return collapsed; },
      reset() { apply(null); persist(); }
    };
  }

  function createPanel(savedGeometry, controlsCollapsed = false) {
    host = element('div'); host.id = 'ykt-local-search-host';
    host.style.cssText = 'position:fixed!important;right:16px!important;top:20px!important;z-index:2147483647!important;display:block!important;';
    const shadow = host.attachShadow({ mode: 'open' }), style = element('style');
    style.textContent = `
      :host{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#202b3c;font-size:14px;line-height:1.6;color-scheme:light}
      *{box-sizing:border-box}.panel{position:relative;display:flex;flex-direction:column;background:#fff;border:1px solid #cfd8e5;border-radius:12px;box-shadow:0 10px 36px #17253a30;overflow:hidden}
      header{padding:12px 14px;background:#eef4fb;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0;cursor:move;touch-action:none;user-select:none}h2{font-size:15px;margin:0;min-width:0}.window-actions{display:flex;gap:6px;flex-shrink:0}h3{font-size:14px;margin:7px 0;white-space:pre-wrap;overflow-wrap:anywhere}
      button{font:inherit;font-size:13px;padding:5px 10px;border:1px solid #c2cfe1;border-radius:6px;background:#fff;color:#234877;cursor:pointer}button:hover{background:#edf4ff}button:disabled{opacity:.55;cursor:wait}button.primary{background:#285b98;color:#fff;border-color:#285b98}
      .body{padding:12px 14px 24px;overflow:auto;overscroll-behavior:contain;min-height:0;flex:1}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.bank,.hint,.source{font-size:12px;color:#5d6d81;overflow-wrap:anywhere}.bank{margin-bottom:9px}
      .controls-toolbar{position:sticky;top:-12px;z-index:1;background:#fff;padding:4px 0 9px}.controls-toolbar button{width:100%;text-align:left}.controls[hidden]{display:none}
      .auto-answer-bar{border:1px solid #d4dfec;background:#f5f8fc;border-radius:7px;padding:8px;margin-bottom:10px}.auto-answer-status{font-size:12px;color:#3f5c7c;margin-top:5px;overflow-wrap:anywhere}
      textarea{display:block;width:100%;min-height:82px;max-height:240px;resize:vertical;border:1px solid #bdcadd;border-radius:7px;padding:8px;font:inherit;font-size:13px;color:#202b3c;background:#fff;margin:9px 0}label{font-size:13px;cursor:pointer}input{vertical-align:middle}
      textarea.image-drop{border:2px dashed #285b98;background:#edf4ff;outline:3px solid #285b9820}
      .status{font-size:12px;color:#3f5c7c;margin:9px 0;overflow-wrap:anywhere}.card{border:1px solid #d9e2ee;border-radius:8px;padding:11px;margin-top:10px}.meta{font-size:12px;color:#5a6f8c}.options>div{padding:3px 0;white-space:pre-wrap;overflow-wrap:anywhere}.answer{background:#edf7f2;border-radius:6px;padding:8px;margin-top:9px;white-space:pre-wrap;overflow-wrap:anywhere}.warning{color:#995500;font-size:12px;background:#fff7e8;padding:6px;border-radius:4px}.source{margin-top:8px}p{margin:7px 0}.note{font-size:12px;color:#67778c;margin:8px 0 0}
      .panel.collapsed .body,.panel.collapsed .resize-handle{display:none}.results{margin-top:8px}
      .resize-handle{position:absolute;right:1px;bottom:1px;width:22px;height:22px;padding:0;border:0;border-radius:0 0 10px 0;background:linear-gradient(135deg,transparent 45%,#8fa6c0 46%,#8fa6c0 52%,transparent 53%,transparent 64%,#8fa6c0 65%,#8fa6c0 71%,transparent 72%);cursor:nwse-resize;touch-action:none}.resize-handle:hover{background-color:#dce9f7}.adjusting{user-select:none}
      details{font-size:12px;color:#526880;margin:8px 0}summary{cursor:pointer}details img{display:block;max-width:100%;max-height:240px;object-fit:contain;border:1px solid #d9e2ee;margin-top:6px}
    `;
    const panel = element('section', undefined, 'panel'), header = element('header'), collapse = element('button', '收起');
    header.append(element('h2', '题库检索 5.1.2')); header.title = '拖动标题栏移动窗口';
    let geometryControl;
    collapse.onclick = () => { collapse.textContent = geometryControl.collapse() ? '展开' : '收起'; };
    const reset = element('button', '复位'); reset.title = '恢复窗口默认位置和大小'; reset.onclick = () => geometryControl.reset();
    const actions = element('div', undefined, 'window-actions'); actions.append(reset, collapse); header.append(actions);
    const body = element('div', undefined, 'body'), bank = element('div', '尚未导入题库', 'bank'), row = element('div', undefined, 'row');
    const importButton = element('button', '导入 JSON'), file = element('input');
    file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    importButton.onclick = () => file.click(); file.onchange = () => void importBank(file.files[0]);
    const ocr = element('button', '识别当前题目'); ocr.onclick = () => { if (autoAnswer?.enabled) autoAnswer.stop('已切换为手动识别，自动选择停止'); void recognize(true); };
    const imageButton = element('button', '导入截图识别'), imageFile = element('input');
    imageButton.onpointerenter = warmOCR;
    imageFile.type = 'file'; imageFile.accept = 'image/png,image/jpeg,image/webp'; imageFile.hidden = true;
    imageButton.onclick = () => imageFile.click(); imageFile.onchange = () => void recognizeScreenshot(imageFile.files[0]);
    const capture = element('button', '开启真实画面识别'); capture.onclick = () => void toggleCapture();
    const autoLabel = element('label'), auto = element('input'); auto.type = 'checkbox'; auto.checked = state.auto;
    auto.onchange = async () => {
      if (autoAnswer?.enabled) autoAnswer.stop('自动识别设置已改变，自动选择停止');
      state.auto = auto.checked; state.epoch++; state.fingerprint = ''; state.attempt = '';
      if (state.busy) clearResults('自动识别设置已变化，等待当前 OCR 结束。');
      try { await GM_setValue(KEYS.auto, state.auto); status(state.auto ? '自动 OCR 已开启' : '自动 OCR 已关闭，可手动检索'); }
      catch (error) { status(`设置保存失败：${error.message || error}`); }
    };
    autoLabel.append(auto, document.createTextNode(' 自动识别')); row.append(importButton, ocr, capture, imageButton, autoLabel, file, imageFile);
    const query = element('textarea'); query.placeholder = '拖入题目截图，或点击此处按 ⌘ / Ctrl + V 粘贴图片，即可识别并检索。也可输入关键词，按 ⌘ / Ctrl + Enter 检索。'; query.setAttribute('aria-label', 'OCR 文本或检索关键词');
    bindScreenshotInput(query, recognizeScreenshot, status);
    query.oninput = () => {
      if (autoAnswer?.enabled) autoAnswer.stop('检索文字被手动编辑，自动选择停止');
      state.epoch++;
      // 手动编辑后暂停当前题的自动识别，直到切题或手动重新识别。
      const signature = fingerprint(findQuestion()); state.fingerprint = signature; state.stable = signature;
      status('文本已编辑，点击“检索题库”查看结果；当前题自动识别已暂停');
    };
    const search = element('button', '检索题库', 'primary');
    search.onclick = () => { if (autoAnswer?.enabled) autoAnswer.stop('已切换为手动检索，自动选择停止'); const started = performance.now(); renderResults(query.value); status(`检索完成 · ${(performance.now() - started).toFixed(0)} 毫秒`); };
    query.onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); search.click(); } };
    const message = element('div', '导入转换脚本生成的 question_bank.json 后开始。', 'status'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const results = element('div', undefined, 'results'), note = element('p', '答案字母按题库原顺序展示，请结合选项文字核对。题库与检索保存在脚本本地存储。', 'note');
    const captureState = element('p', '共享状态：未连接。防复制页面请开启共享，或导入系统截图。', 'hint');
    const source = element('p', '本次识别来源：尚未识别', 'hint');
    const preview = element('details'), previewImage = element('img'), previewLabel = element('summary', '查看实际送入 OCR 的截图'); preview.hidden = true; previewImage.alt = '实际送入 OCR 的截图';
    preview.append(previewLabel, previewImage);
    preview.ontoggle = () => { if (preview.open) updatePreviewImage(); };
    const dropHint = element('p', '可将截图直接拖到文字框', 'hint');
    const resizeHandle = element('button', undefined, 'resize-handle'); resizeHandle.title = '拖动调整窗口宽度和高度，也可用方向键调整'; resizeHandle.setAttribute('aria-label', '调整窗口大小');
    const controls = element('div', undefined, 'controls'); controls.id = 'ykt-search-controls';
    controls.append(bank, row, captureState, query, dropHint, search, message, source, preview, note);
    const controlsToolbar = element('div', undefined, 'controls-toolbar'), toggleControls = element('button');
    toggleControls.setAttribute('aria-controls', controls.id);
    const applyControlsVisibility = () => {
      controls.hidden = controlsCollapsed;
      toggleControls.textContent = controlsCollapsed ? '展开识别与检索区' : '收起识别与检索区';
      toggleControls.setAttribute('aria-expanded', String(!controlsCollapsed));
    };
    toggleControls.onclick = async () => {
      controlsCollapsed = !controlsCollapsed; applyControlsVisibility(); body.scrollTop = 0;
      try { await GM_setValue(KEYS.controls, controlsCollapsed); }
      catch (error) { console.warn('识别区折叠状态保存失败', error); }
    };
    applyControlsVisibility(); controlsToolbar.append(toggleControls);
    const autoAnswerBar = element('div', undefined, 'auto-answer-bar'), autoAnswerRow = element('div', undefined, 'row');
    const autoAnswerButton = element('button', '自动选择选项', 'primary');
    const autoAnswerStatus = element('div', '未开启。首项匹配分 ≥ 60 且答案明确时自动选择，提交请手动操作。', 'auto-answer-status'); autoAnswerStatus.setAttribute('role', 'status'); autoAnswerStatus.setAttribute('aria-live', 'polite');
    autoAnswerButton.onclick = () => void toggleAutoAnswer().catch(error => autoAnswer.stop(`启动失败：${error.message || error}`));
    autoAnswerRow.append(autoAnswerButton); autoAnswerBar.append(autoAnswerRow, autoAnswerStatus);
    body.append(controlsToolbar, autoAnswerBar, controls, results); panel.append(header, body, resizeHandle); shadow.append(style, panel); document.body.append(host);
    ui = { bank, importButton, file, ocr, capture, captureState, source, imageButton, imageFile, preview, previewLabel, previewImage, auto, query, autoAnswerButton, autoAnswerStatus, status: message, results };
    geometryControl = enablePanelGeometry(panel, header, resizeHandle, savedGeometry);
  }

  async function tick() {
    if (autoAnswer?.enabled && autoAnswer.poll()) return;
    if (!state.auto || !state.index || state.busy || capturePending || document.hidden) return;
    const signature = fingerprint(findQuestion());
    if (!signature) {
      if (state.stable) { state.stable = ''; state.fingerprint = ''; state.epoch++; clearResults('当前没有可见题目，等待打开题目页面。'); }
      return;
    }
    if (signature !== state.stable) {
      state.stable = signature; state.seenAt = Date.now(); state.epoch++;
      clearResults('检测到当前题目，等待页面稳定后识别…'); return;
    }
    if (Date.now() - state.seenAt > 400) await recognize();
  }
  async function boot() {
    if (window.top !== window.self || document.getElementById('ykt-local-search-host')) return;
    let saved = null, savedGeometry = null, controlsCollapsed = false, loadError = '';
    try { state.auto = Boolean(await GM_getValue(KEYS.auto, true)); saved = await GM_getValue(KEYS.bank, null); savedGeometry = await GM_getValue(KEYS.window, null); controlsCollapsed = Boolean(await GM_getValue(KEYS.controls, false)); }
    catch (error) { loadError = `本地存储读取失败：${error.message || error}`; }
    createPanel(savedGeometry, controlsCollapsed);
    autoAnswer = createAutoSession();
    if (saved) {
      try {
        const questions = validateBank(saved); state.index = new QuestionIndex(questions);
        ui.bank.textContent = `${saved.name || '已保存题库'} · ${questions.length} 道题`; status('已加载本地题库，打开题目页面即可识别。');
      } catch (error) { loadError = `已保存题库无法加载，请重新导入：${error.message || error}`; }
    }
    if (loadError) status(loadError);
    clearResults(state.index ? '等待当前题目，或输入关键词检索。' : '请先导入 question_bank.json。');
    if (state.index && state.auto) {
      if (window.requestIdleCallback) window.requestIdleCallback(warmOCR, { timeout: 1500 });
      else setTimeout(warmOCR, 500);
    }
    const startTimer = () => setInterval(() => { void tick().catch(error => { if (autoAnswer?.enabled) autoAnswer.stop(`页面检测失败：${error.message || error}`); status(`页面检测失败：${error.message || error}`); }); }, 600);
    let timer = startTimer();
    window.addEventListener('pagehide', () => { clearInterval(timer); state.epoch++; stopCapture(); if (ui.previewURL) URL.revokeObjectURL(ui.previewURL); const old = workerPromise; workerPromise = null; old?.then(w => w.terminate()).catch(() => {}); });
    window.addEventListener('pageshow', event => { if (event.persisted) { clearInterval(timer); timer = startTimer(); state.fingerprint = ''; } });
    document.addEventListener('visibilitychange', () => { if (document.hidden && autoAnswer?.enabled) autoAnswer.stop('页面已转入后台，自动选择停止'); });
  }
  void boot();
})();
