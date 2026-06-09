const assert = require('assert');
const rules = require('./contentRules');

function check(name, text, context, expected) {
  const actual = rules.validateChildAgeRule(text, { context });
  assert.strictEqual(actual.ok, expected.ok, `${name}: expected ok=${expected.ok}, got ${actual.ok} (${actual.message})`);
  if (expected.hit) {
    assert(actual.hits.includes(expected.hit), `${name}: expected hit ${expected.hit}, got ${actual.hits.join(',')}`);
  }
  if (expected.noHit) {
    assert(!actual.hits.includes(expected.noHit), `${name}: did not expect hit ${expected.noHit}, got ${actual.hits.join(',')}`);
  }
}

check(
  'blocks explicit age under 7',
  '今天写一个3岁孩子第一次上课的故事。',
  '亲子教育内容',
  { ok: false, hit: '3岁' }
);

check(
  'blocks kindergarten scene',
  '选题：幼儿园小班入园哭闹，妈妈怎么安抚。',
  '亲子教育内容',
  { ok: false, hit: '幼儿园小班' }
);

check(
  'does not block negative constraints',
  '画面主体：小学三年级孩子在书桌前改错题。\n负面约束：不要幼儿园插画风，不要早教机构广告图。',
  '封面提示词',
  { ok: true, noHit: '幼儿园' }
);

check(
  'does not block baby as ambiguous nickname',
  '我家宝宝上初一后，最明显的变化不是成绩，而是开始要面子。',
  '亲子沟通',
  { ok: true, noHit: '宝宝' }
);

check(
  'allows primary school scene',
  '小学三年级孩子写作业拖拉，妈妈先别急着催。',
  '教育文案',
  { ok: true }
);

check(
  'blocks visual subject low-age wording',
  '画面主体：一个幼儿坐在地毯上拿着奶瓶。',
  '封面提示词',
  { ok: false, hit: '幼儿' }
);

check(
  'does not block banned word inside prohibition line',
  '禁止出现：幼儿、奶瓶、尿布。\n画面主体：初一学生在旧书桌旁整理错题本。',
  '完整图文套图方案',
  { ok: true, noHit: '幼儿' }
);

assert.strictEqual(
  rules.stripDecorativeIcons('开头先别急着骂孩子 😭，先看他卡在哪一步 ✨'),
  '开头先别急着骂孩子 ，先看他卡在哪一步',
  'removes decorative emoji from spoken copy'
);

assert.strictEqual(
  rules.stripDecorativeIcons('#小升初 #学习习惯 #亲子沟通'),
  '#小升初 #学习习惯 #亲子沟通',
  'keeps normal hashtag text'
);

assert.strictEqual(
  rules.sanitizeChildAgeTerms('2岁孩子拿着奶瓶，5岁弟弟在幼儿园小班门口哭。'),
  '7-17岁孩子拿着书包，7-17岁弟弟在小学阶段门口哭。',
  'sanitizes low-age terms before prompt reuse'
);

console.log('contentRules tests passed');
