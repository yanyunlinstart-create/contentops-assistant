(function(root){
  const CHILD_AGE_CONTEXT_RE=/儿童|孩子|学生|小孩|亲子|教育|宝妈|妈妈|家长|小学|初中|小升初|作业|考试|老师|同学|青春期|学习|家庭|初一|初二|初三|一年级|二年级|三年级|四年级|五年级|六年级/;
  const LOW_AGE_CHILD_RE=/幼儿园小班|幼儿园中班|幼儿园大班|婴幼儿|幼儿园|婴儿|幼儿|萌娃|学步|奶瓶|尿布|纸尿裤|辅食|奶粉|早教|托班|托育|小班|中班|大班|三岁|四岁|五岁|六岁|0岁|1岁|2岁|3岁|4岁|5岁|6岁|[一二三四五六]岁|6岁以下|六岁以下/;
  const EXEMPT_LINE_RE=/负面约束|禁止出现|不要|不得|避免|不能出现|儿童年龄硬约束|低龄儿童词|低龄角色|删除或替换/;
  const DECORATIVE_ICON_RE=/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu;

  function childAgeHardRuleText(){
    return `【儿童年龄硬约束】
- 只要内容涉及儿童、孩子、学生、小孩、亲子、教育、宝妈、妈妈、家长等场景，角色年龄必须限定在7-17岁。
- 只允许小学一年级至六年级、初一至初三、小升初、青春期早期等7-17岁场景。
- 禁止出现：婴儿、婴幼儿、幼儿、萌娃、学步儿童、奶瓶、尿布、纸尿裤、辅食、奶粉、早教、托班、托育、幼儿园小班/中班/大班、3岁、4岁、5岁、6岁以下等明确低龄角色或物品。
- “宝宝/宝贝”可能只是口语称呼，不单独作为硬失败词；生成时仍优先写“孩子/小学生/初中生”。
- 封面/图文/素材关键词也必须遵守，不能出现低龄儿童视觉元素。`;
  }

  function stripChildAgeExemptionText(text){
    return String(text||'')
      .split(/\n/)
      .filter(line=>!EXEMPT_LINE_RE.test(line))
      .join('\n');
  }

  function sanitizeChildAgeTerms(text){
    return String(text||'')
      .replace(/幼儿园小班|幼儿园中班|幼儿园大班|幼儿园|托班|托育|早教/g,'小学阶段')
      .replace(/婴幼儿|婴儿|幼儿|萌娃|学步儿童|学步/g,'小学生')
      .replace(/奶瓶|尿布|纸尿裤|辅食|奶粉/g,'书包')
      .replace(/0岁|1岁|2岁|3岁|4岁|5岁|6岁|[一二三四五六]岁|6岁以下|六岁以下/g,'7-17岁')
      .replace(/小班|中班|大班/g,'小学班级');
  }

  function validateChildAgeRule(text,options={}){
    const body=String(text||'');
    const context=String(options.context||'');
    const bodyForHits=stripChildAgeExemptionText(body);
    const lowHits=[...new Set((bodyForHits.match(new RegExp(LOW_AGE_CHILD_RE.source,'g'))||[]).filter(Boolean))];
    const combined=`${context}\n${body}`;
    const triggered=CHILD_AGE_CONTEXT_RE.test(combined)||lowHits.length>0;
    return {
      triggered,
      ok:!triggered||!lowHits.length,
      hits:lowHits,
      message:triggered
        ? (lowHits.length?`命中低龄儿童词：${lowHits.slice(0,8).join('、')}`:'已触发儿童年龄规则校验，未发现低龄词。')
        : ''
    };
  }

  function stripDecorativeIcons(text){
    return String(text||'')
      .replace(DECORATIVE_ICON_RE,'')
      .replace(/[ \t]{2,}/g,' ')
      .replace(/\n{3,}/g,'\n\n')
      .trim();
  }

  const api={
    childAgeHardRuleText,
    stripChildAgeExemptionText,
    sanitizeChildAgeTerms,
    validateChildAgeRule,
    stripDecorativeIcons,
    rules:{
      childAgeContext:CHILD_AGE_CONTEXT_RE,
      lowAgeChild:LOW_AGE_CHILD_RE,
      exemptLine:EXEMPT_LINE_RE,
      decorativeIcon:DECORATIVE_ICON_RE
    }
  };

  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.ContentRules=api;
})(typeof globalThis!=='undefined'?globalThis:this);
