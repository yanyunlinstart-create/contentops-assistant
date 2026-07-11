const assert = require('assert');
const fs = require('fs');

const htmlFile = fs.readdirSync('.').find((name) => name.endsWith('.html'));
assert(htmlFile, 'html file not found');

const html = fs.readFileSync(htmlFile, 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join('\n');
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join('\n');
const compactCss = styles.replace(/\s+/g, ' ');

function bodyOf(name) {
  const start = scripts.indexOf(`function ${name}`);
  assert(start >= 0, `${name} not found`);
  const next = scripts.indexOf('\nfunction ', start + 1);
  return scripts.slice(start, next > start ? next : scripts.length);
}

assert(
  /\.review-center-metric\{[^}]*cursor:pointer/.test(compactCss)
    && /\.review-center-metric\.active,\.review-center-metric:focus-visible\{[^}]*outline/.test(compactCss),
  'review metric cards should be clickable controls with active and keyboard focus states'
);

assert(
  /\.post-review-bulkbar\.active\{[^}]*position:sticky[^}]*top:116px/.test(compactCss),
  'production sticky bulk bar should avoid the real header and top status bar'
);

assert(
  scripts.includes('let _postPublishReviewActiveGroup')
    && scripts.includes('POST_PUBLISH_REVIEW_GROUPS')
    && scripts.includes('function resolvePostPublishReviewActiveGroup'),
  'review center should keep an in-memory active group state'
);

assert(
  scripts.includes('function renderPostPublishReviewMetricButton')
    && scripts.includes('aria-pressed="${activeGroup===item.key}"')
    && scripts.includes('onclick="setPostPublishReviewActiveGroup('),
  'metric cards should render as keyboard-focusable group switch buttons'
);

const resolveBody = bodyOf('resolvePostPublishReviewActiveGroup');
assert(
  resolveBody.includes('current&&counts[current]>0')
    && resolveBody.includes('POST_PUBLISH_REVIEW_GROUPS.find(group=>counts[group.key]>0)')
    && resolveBody.includes(":'empty'"),
  'default and fallback active group should use the first non-empty pending group'
);

const setActiveBody = bodyOf('setPostPublishReviewActiveGroup');
assert(
  setActiveBody.includes('_postPublishReviewActiveGroup=groupKey')
    && setActiveBody.includes('clearPostPublishReviewSelection()')
    && setActiveBody.includes('renderPostPublishReviewPanel'),
  'switching active group should clear selection, hide bulk actions, and re-render'
);

const selectBody = bodyOf('selectPostPublishReviewGroup');
assert(
  selectBody.includes('getPostPublishCurrentSelectableGroup()')
    && selectBody.includes('[data-review-group="${currentGroup}"]')
    && !selectBody.includes('checked=false'),
  'select all group should only select the currently displayed group'
);

const selectedBody = bodyOf('getSelectedPostPublishReviewSelections');
assert(
  selectedBody.includes('#postPublishReviewList .post-review-select:checked'),
  'selected records should come only from the currently rendered main review list'
);

const renderBody = bodyOf('renderPostPublishReviewPanel');
assert(
  renderBody.includes('const activeGroup=resolvePostPublishReviewActiveGroup')
    && renderBody.includes("activeGroup==='archive'")
    && renderBody.includes("activeGroup==='empty'")
    && renderBody.includes('renderPostPublishReviewGroup(activeMeta.title,activeItems,activeMeta.tone,activeMeta.key)')
    && !renderBody.includes("renderPostPublishReviewGroup('20 "),
  'main content should render only the currently selected group, archive, or empty state'
);

assert(
  renderBody.includes("renderPostPublishReviewGroup('")
    && renderBody.includes("archived,''")
    && renderBody.includes("{selectable:false}"),
  'archive group should render in the main area as read-only when selected'
);

assert(
  renderBody.includes("metrics.push({key:'archive'")
    && scripts.includes('activeGroup===item.key')
    && renderBody.includes('metricsHtml'),
  'history archive metric should be part of the same group-switch control set'
);

assert(
  renderBody.includes('updatePostPublishBulkBar()')
    && bodyOf('updatePostPublishBulkBar').includes("_postPublishReviewActiveGroup!=='archive'"),
  'bulk bar should stay hidden in archive view and after selection is cleared'
);

assert(
  scripts.includes('bulkSelectedPostPublishReviewAction')
    && scripts.includes('applyPostPublishBulkAction(selections,action)')
    && scripts.includes('continuePostPublishObserve')
    && scripts.includes('stopPostPublishTracking')
    && scripts.includes('markPostPublishDeletedStopTracking')
    && scripts.includes('confirmPostPublishDeleted'),
  'production bindings should keep the real single and bulk action functions'
);

assert(
  !scripts.includes('data-demo')
    && !scripts.includes('reviewPreviewHarness')
    && !scripts.includes('仅演示界面'),
  'production HTML must not include preview-only demo hooks'
);

console.log('post review layout tests passed');
