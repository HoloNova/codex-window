import test from 'node:test';
import assert from 'node:assert/strict';
import { logStyle } from '../dist/logging.js';
import { english, translate } from '../dist/i18n.js';

test('log categories distinguish execution, confirmed success, retry, and failure without relying on colour', () => {
  for (const [message, label, tone] of [
    ['自动查询完成，窗口进行中', '信息', 'muted'],
    ['查询完成，自动开窗已暂停', '信息', 'muted'],
    ['计划开窗：14:10:30 (UTC)', '执行', 'accent'],
    ['执行开窗指令', '执行', 'accent'],
    ['开窗指令已完成，30 秒后确认', '执行', 'accent'],
    ['已确认开窗', '成功', 'good'],
    ['尚未开窗，补发一次', '注意', 'warning'],
    ['开窗未确认，已停止补发', '注意', 'warning'],
    ['查询完成，开窗结果仍待确认', '注意', 'warning'],
    ['开窗指令失败（HTTP 503）；30 秒后确认', '错误', 'bad'],
  ]) {
    assert.deepEqual(logStyle(message), { label, tone }, message);
    assert.deepEqual(logStyle(english(message)), { label, tone }, english(message));
    assert.equal(translate(english(message), 'zh-CN'), message);
    assert.notEqual(english(label), label, 'each colour category also has a translated textual label');
  }
});
