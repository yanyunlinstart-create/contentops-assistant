const EDUCATION_QUESTION_CONTENT_TYPE = '教育题目类';

const EDUCATION_QUESTION_SUBJECTS = ['数学', '语文', '英语', '逻辑思维', '小升初综合', '随机'];
const RANDOM_SUBJECT_POOL = ['数学', '语文', '英语', '逻辑思维', '小升初综合'];
const EDUCATION_QUESTION_SCENES = [
  '小升初真题感',
  '校内同步题',
  '易错题',
  '压轴题',
  '基础巩固题',
  '家长辅导题',
  '孩子容易粗心题'
];
const EDUCATION_QUESTION_PRESENTATION_STYLES = [
  '直接展示题目',
  '先抛问题再给题目',
  '家长吐槽引入题目',
  '孩子做错引入题目',
  '评论区挑战题',
  '解析型题目'
];

const AVOID_PHRASES = [
  '这道题难倒了很多孩子',
  '家长们快来看看',
  '你家孩子会做吗',
  '小升初必考',
  '很多孩子都做错了'
];

const SUBJECT_QUESTION_DIRECTIONS = {
  数学: [
    '小升初应用题',
    '行程问题',
    '工程问题',
    '分数百分数',
    '几何图形',
    '鸡兔同笼',
    '浓度问题',
    '比例问题'
  ],
  语文: [
    '修改病句',
    '句子排序',
    '阅读理解',
    '成语运用',
    '古诗理解',
    '标点符号',
    '近义词辨析'
  ],
  英语: [
    '单项选择',
    '完形填空',
    '句型转换',
    '阅读判断',
    '时态选择',
    '介词搭配'
  ],
  逻辑思维: [
    '数字规律',
    '图形规律',
    '推理判断',
    '排列组合',
    '条件推理'
  ],
  小升初综合: [
    '数学+语文混合',
    '阅读材料+问题',
    '生活场景题',
    '综合能力挑战题'
  ]
};

const QUESTION_TYPE_PATTERNS = [
  { type: '修改病句', subject: '语文', pattern: /修改病句|病句|改病句/ },
  { type: '阅读理解', subject: '语文', pattern: /阅读理解|阅读题|短文阅读|阅读材料/ },
  { type: '选择题', subject: '', pattern: /选择题|单项选择|单选题|多选题/ },
  { type: '填空题', subject: '', pattern: /填空题|填空/ },
  { type: '成语题', subject: '语文', pattern: /成语题|成语运用|成语/ },
  { type: '古诗题', subject: '语文', pattern: /古诗题|古诗理解|诗词|古诗/ },
  { type: '英语语法题', subject: '英语', pattern: /英语语法|语法题|时态|介词搭配|句型转换|完形填空/ },
  { type: '应用题', subject: '数学', pattern: /应用题|行程问题|工程问题|鸡兔同笼|浓度问题|比例问题|几何|分数|百分数/ },
  { type: '逻辑题', subject: '逻辑思维', pattern: /逻辑题|逻辑思维|数字规律|图形规律|推理|排列组合|条件推理/ }
];

const GRADE_PATTERNS = [
  { grade: '小升初', pattern: /小升初|升初中/ },
  { grade: '小学', pattern: /小学/ },
  { grade: '一年级', pattern: /一年级|1年级|一上|一下/ },
  { grade: '二年级', pattern: /二年级|2年级|二上|二下/ },
  { grade: '三年级', pattern: /三年级|3年级|三上|三下/ },
  { grade: '四年级', pattern: /四年级|4年级|四上|四下/ },
  { grade: '五年级', pattern: /五年级|5年级|五上|五下/ },
  { grade: '六年级', pattern: /六年级|6年级|六上|六下/ },
  { grade: '初一', pattern: /初一|七年级|7年级/ }
];

const STYLE_PATTERNS = [
  { style: '生活化', pattern: /生活化|日常|口语/ },
  { style: '宝妈口吻', pattern: /宝妈|妈妈|母亲/ },
  { style: '小红书', pattern: /小红书/ },
  { style: '真实分享', pattern: /真实分享|真实|真题感|真实题目/ },
  { style: '孩子做错', pattern: /孩子做错|做错|错题/ },
  { style: '家长辅导', pattern: /家长辅导|辅导孩子|陪写作业/ }
];

function uniqueList(items) {
  return [...new Set(items.filter(Boolean))];
}

function pickFirstPresent(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
}

function normalizeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeChoice(value, allowed, fallback) {
  const text = normalizeText(value, fallback);
  return allowed.includes(text) ? text : fallback;
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'on', '是', '开启', '必须', '需要'].includes(text)) return true;
  if (['false', 'no', 'n', '0', 'off', '否', '关闭', '不需要'].includes(text)) return false;
  return fallback;
}

function resolveSubject(subject) {
  if (subject !== '随机') return subject;
  return RANDOM_SUBJECT_POOL[Math.floor(Math.random() * RANDOM_SUBJECT_POOL.length)];
}

function normalizeSubjectAlias(subject) {
  const text = normalizeText(subject);
  if (!text) return '';
  if (/语文|中文|病句|成语|古诗|阅读理解/.test(text)) return '语文';
  if (/英语|英文|语法|单词|时态/.test(text)) return '英语';
  if (/逻辑|推理|规律/.test(text)) return '逻辑思维';
  if (/综合|小升初综合|跨学科/.test(text)) return '小升初综合';
  if (/数学/.test(text)) return '数学';
  return EDUCATION_QUESTION_SUBJECTS.includes(text) ? text : '';
}

function inferQuestionScene(text) {
  if (/真题|真实题目|真题感/.test(text)) return '小升初真题感';
  if (/校内|同步/.test(text)) return '校内同步题';
  if (/易错|错题|粗心/.test(text)) return '易错题';
  if (/压轴|难题|拔高/.test(text)) return '压轴题';
  if (/基础|巩固/.test(text)) return '基础巩固题';
  if (/家长辅导|辅导/.test(text)) return '家长辅导题';
  return '';
}

function inferPresentationStyle(text) {
  if (/先抛问题|先提问|抛问题/.test(text)) return '先抛问题再给题目';
  if (/家长吐槽|吐槽/.test(text)) return '家长吐槽引入题目';
  if (/孩子做错|做错|错题/.test(text)) return '孩子做错引入题目';
  if (/评论区|挑战/.test(text)) return '评论区挑战题';
  if (/解析|讲解|答案/.test(text)) return '解析型题目';
  return '';
}

function parseEducationRemark(remark = '') {
  const text = normalizeText(remark);
  const parsed = {
    rawRemark: text,
    subject: '',
    grade: '',
    questionType: '',
    questionScene: '',
    presentationStyle: '',
    mustIncludeQuestion: false,
    forbiddenSubjects: [],
    forbiddenRules: [],
    contentStyle: '',
    contentStyles: []
  };

  if (!text) return parsed;

  parsed.subject = normalizeSubjectAlias(text);

  for (const item of GRADE_PATTERNS) {
    if (item.pattern.test(text)) {
      parsed.grade = item.grade;
      break;
    }
  }

  for (const item of QUESTION_TYPE_PATTERNS) {
    if (item.pattern.test(text)) {
      parsed.questionType = item.type;
      if (!parsed.subject && item.subject) parsed.subject = item.subject;
      break;
    }
  }

  parsed.questionScene = inferQuestionScene(text);
  parsed.presentationStyle = inferPresentationStyle(text);

  if (/题目|真题|例题|练习题|选择题|阅读题|阅读理解|题干|带一道|出一道/.test(text)) {
    parsed.mustIncludeQuestion = true;
  }

  if (/不要数学|别.*数学|不.*数学|别老是数学|不要只生成数学题|不要只写数学|不要总是数学/.test(text)) {
    parsed.forbiddenSubjects.push('数学');
    parsed.forbiddenRules.push('禁止生成数学题');
  }

  if (/不要鸡汤|别.*鸡汤|不.*鸡汤/.test(text)) {
    parsed.forbiddenRules.push('禁止输出鸡汤观点');
  }

  if (/不要泛泛而谈|别泛泛而谈|不泛泛|不要空泛|不要泛教育/.test(text)) {
    parsed.forbiddenRules.push('禁止泛泛而谈，必须围绕具体题目');
  }

  parsed.contentStyles = STYLE_PATTERNS
    .filter(item => item.pattern.test(text))
    .map(item => item.style);

  if (/真实题目|真题|例题/.test(text)) parsed.contentStyles.push('真实题目感');
  parsed.contentStyles = uniqueList(parsed.contentStyles);
  parsed.contentStyle = parsed.contentStyles.join('、');

  return parsed;
}

function pickSubjectExcludingForbidden(subject, forbiddenSubjects) {
  const forbidden = new Set(forbiddenSubjects || []);
  const normalized = normalizeSubjectAlias(subject) || subject;
  if (normalized && normalized !== '随机' && !forbidden.has(normalized)) return normalized;

  const allowed = RANDOM_SUBJECT_POOL.filter(item => !forbidden.has(item));
  if (!allowed.length) return normalized || '语文';
  return allowed[Math.floor(Math.random() * allowed.length)];
}

function normalizeEducationQuestionPayload(body = {}) {
  const remark = normalizeText(pickFirstPresent(body, ['remark', 'remarks', 'note', '备注', '用户备注']));
  const subject = normalizeChoice(
    pickFirstPresent(body, ['subject', 'questionSubject', '题目学科']),
    EDUCATION_QUESTION_SUBJECTS,
    '随机'
  );
  const resolvedSubject = resolveSubject(subject);
  const grade = normalizeText(pickFirstPresent(body, ['grade', 'stage', '年级', '年级/阶段']), '小学高年级/小升初');
  const questionScene = normalizeChoice(
    pickFirstPresent(body, ['questionScene', 'scene', '题目场景']),
    EDUCATION_QUESTION_SCENES,
    '小升初真题感'
  );
  const presentationStyle = normalizeChoice(
    pickFirstPresent(body, ['presentationStyle', 'questionPresentationStyle', '题目呈现方式']),
    EDUCATION_QUESTION_PRESENTATION_STYLES,
    '直接展示题目'
  );
  const contentType = normalizeText(pickFirstPresent(body, ['contentType', '内容类型']), EDUCATION_QUESTION_CONTENT_TYPE);
  const mustGenerateQuestion = normalizeBoolean(
    pickFirstPresent(body, ['mustGenerateQuestion', 'requireQuestion', '是否必须生成题目']),
    true
  );

  return {
    contentType,
    subject,
    resolvedSubject,
    grade,
    questionScene,
    presentationStyle,
    mustGenerateQuestion: contentType === EDUCATION_QUESTION_CONTENT_TYPE ? true : mustGenerateQuestion,
    accountPersona: normalizeText(pickFirstPresent(body, ['accountPersona', '账号人设']), '宝妈账号'),
    platform: normalizeText(pickFirstPresent(body, ['platform', '平台']), '小红书'),
    questionType: normalizeText(pickFirstPresent(body, ['questionType', '题型']), ''),
    remark,
    extraRequirement: normalizeText(pickFirstPresent(body, ['extraRequirement', '补充要求', '其他要求']), '')
  };
}

function buildEducationGenerationConfig(baseConfig = {}, remarkParsed = {}) {
  const forbiddenSubjects = uniqueList(remarkParsed.forbiddenSubjects || []);
  const forbiddenRules = uniqueList(remarkParsed.forbiddenRules || []);
  const remarkSubject = normalizeSubjectAlias(remarkParsed.subject);
  const questionTypeSubject = QUESTION_TYPE_PATTERNS.find(item => item.type === remarkParsed.questionType)?.subject || '';
  const preferredSubject = remarkSubject || questionTypeSubject || baseConfig.subject || baseConfig.resolvedSubject;
  const resolvedSubject = pickSubjectExcludingForbidden(preferredSubject, forbiddenSubjects);
  const subject = remarkSubject || (baseConfig.subject === '随机' ? '随机' : resolvedSubject);
  const mustGenerateQuestion = Boolean(
    remarkParsed.mustIncludeQuestion ||
    baseConfig.mustGenerateQuestion ||
    baseConfig.contentType === EDUCATION_QUESTION_CONTENT_TYPE
  );

  return {
    ...baseConfig,
    subject,
    resolvedSubject,
    grade: remarkParsed.grade || baseConfig.grade,
    questionType: remarkParsed.questionType || baseConfig.questionType || '',
    questionScene: remarkParsed.questionScene || baseConfig.questionScene,
    presentationStyle: remarkParsed.presentationStyle || baseConfig.presentationStyle,
    mustGenerateQuestion,
    mustIncludeQuestion: mustGenerateQuestion,
    forbiddenSubjects,
    forbiddenRules,
    contentStyle: remarkParsed.contentStyle || baseConfig.contentStyle || '',
    contentStyles: remarkParsed.contentStyles || [],
    remarkParsed
  };
}

function buildEducationQuestionPrompt(body = {}) {
  const baseConfig = normalizeEducationQuestionPayload(body);
  const remarkParsed = parseEducationRemark(baseConfig.remark || baseConfig.extraRequirement);
  const finalConfig = buildEducationGenerationConfig(baseConfig, remarkParsed);
  const directions = SUBJECT_QUESTION_DIRECTIONS[finalConfig.resolvedSubject] || [];
  const forbiddenText = uniqueList([
    ...(finalConfig.forbiddenSubjects || []).map(subject => `禁止生成${subject}题`),
    ...(finalConfig.forbiddenRules || [])
  ]).join('；') || '无';

  const prompt = [
    `你是一个${finalConfig.platform}教育内容策划助手，请生成一篇适合${finalConfig.accountPersona}发布的教育题目类文案。`,
    '',
    '【最高优先级要求】',
    '以下是用户备注中提取出的硬性要求，必须严格执行，优先级高于默认分类、系统推荐和随机题型：',
    `学科：${finalConfig.resolvedSubject}`,
    `年级：${finalConfig.grade}`,
    `题型：${finalConfig.questionType || '未指定，请从该学科题型方向中选择'}`,
    `题目场景：${finalConfig.questionScene}`,
    `呈现方式：${finalConfig.presentationStyle}`,
    `必须包含完整题目：${finalConfig.mustIncludeQuestion ? '是' : '否'}`,
    `禁止内容：${forbiddenText}`,
    `风格要求：${finalConfig.contentStyle || '生活化、真实分享、不要像培训机构广告'}`,
    `用户原始备注：${finalConfig.remark || '无'}`,
    '',
    '【生成任务】',
    '请根据以上硬性要求生成教育题目类文案。备注解析结果是硬条件，不是参考建议；最终生成只能使用这些最终配置，不允许回退到旧的默认数学模板。',
    '',
    '【强制规则】',
    '1. 如果学科不是数学，禁止生成数学题。',
    `2. 如果 mustIncludeQuestion 为 true，正文中必须包含完整题目；当前 mustIncludeQuestion=${finalConfig.mustIncludeQuestion ? 'true' : 'false'}。`,
    '3. 如果题型是修改病句，必须生成一句有语病的句子，并要求用户修改。',
    '4. 如果题型是阅读理解，必须生成短材料和问题。',
    '5. 如果题型是英语选择题，必须生成英文题干和 A/B/C/D 选项。',
    '6. 不得只输出学习焦虑、家长吐槽、鸡汤观点。',
    '7. 文案必须围绕题目展开。',
    '8. 如果是选择题，必须生成 A/B/C/D 选项。',
    '9. 如果是阅读题，必须包含一段短材料和对应问题。',
    '10. 如果是数学题，数字、条件、问题目标必须完整，不能只写“某应用题”。',
    `11. 本学科可选题型方向：${directions.join('、')}。请结合题型和场景自然选择，不要每次都用数学题。`,
    `12. 避免重复使用这些高频句式：${AVOID_PHRASES.join('；')}。`,
    finalConfig.extraRequirement ? `13. 其他补充要求：${finalConfig.extraRequirement}。` : '',
    '',
    '【输出格式】',
    '标题：',
    '一句有冲突感或挑战感的标题，但不要夸张营销。',
    '开头：',
    '用生活化语言引入，不要堆砌焦虑。',
    '题目：',
    '给出完整题干；选择题给 A/B/C/D；阅读题给短材料和问题；数学题给完整数字和条件。',
    '互动引导：',
    '引导用户评论答案或说出思路。',
    '答案/解析：',
    '可以简短提示，也可以写“答案放在评论区/下一页”。'
  ].filter(Boolean).join('\n');

  return {
    prompt,
    payload: finalConfig,
    baseConfig,
    remarkParsed,
    finalConfig,
    options: getEducationQuestionOptions()
  };
}

function getEducationQuestionOptions() {
  return {
    contentType: EDUCATION_QUESTION_CONTENT_TYPE,
    subjects: EDUCATION_QUESTION_SUBJECTS,
    scenes: EDUCATION_QUESTION_SCENES,
    presentationStyles: EDUCATION_QUESTION_PRESENTATION_STYLES,
    mustGenerateQuestionDefault: true,
    avoidPhrases: AVOID_PHRASES,
    subjectQuestionDirections: SUBJECT_QUESTION_DIRECTIONS,
    questionTypes: QUESTION_TYPE_PATTERNS.map(item => item.type)
  };
}

module.exports = {
  EDUCATION_QUESTION_CONTENT_TYPE,
  buildEducationQuestionPrompt,
  buildEducationGenerationConfig,
  getEducationQuestionOptions,
  normalizeEducationQuestionPayload,
  parseEducationRemark
};
