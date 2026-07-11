const assert = require('assert');
const {
  buildPublicIndex,
  scanPublicHtml,
  extractAccountIdentityStrings
} = require('./scripts/build-public-index');

const privateSource = `
<!doctype html>
<style>.post-review-bulkbar.active{display:flex;position:sticky;top:116px;}</style>
<input id="newAccDevice" placeholder="如：fixture-device-001">
<script>
const ACCS=[
  {id:1,name:'Private Fixture Account A',device:'fixture-device-001',type:'edu',emoji:'A',group:'fixture group'},
  {id:2,name:'Private Fixture Account B',device:'fixture-device-002',type:'edu',emoji:'B',group:'fixture sibling'}
];
const TODAY_RECOVERY_SNAPSHOT={drafts:[{accName:'Private Fixture Account A',device:'fixture-device-001',topic:'private topic'}]};
// Compatibility example: account name Private Fixture Account A
if(window.account && window.account.name==='Private Fixture Account B'){ window.account.type='demo'; }
const POST_PUBLISH_REVIEW_GROUPS=[];
function renderPostPublishReviewMetricButton(){}
function bulkSelectedPostPublishReviewAction(){}
function applyPostPublishBulkAction(){}
function renderPostPublishMoreActions(){}
</script>`;

const identities = extractAccountIdentityStrings(privateSource);
assert(identities.includes('Private Fixture Account A'), 'extracts private account names from source ACCS');
assert(identities.includes('fixture-device-001'), 'extracts private device ids from source ACCS');

const publicHtml = buildPublicIndex(privateSource);
assert(publicHtml.includes("name:'演示账号 A'"), 'public build uses demo account names');
assert(publicHtml.includes("device:'demo-001'"), 'public build uses demo device ids');
assert(!publicHtml.includes('Private Fixture Account A'), 'public build removes private account names');
assert(!publicHtml.includes('fixture-device-001'), 'public build removes private device ids');
assert(publicHtml.includes('placeholder="如：demo-001"'), 'public build replaces private device placeholders');
assert(publicHtml.includes('const TODAY_RECOVERY_SNAPSHOT={}'), 'public build clears recovery snapshot data');
assert(publicHtml.includes('POST_PUBLISH_REVIEW_GROUPS'), 'public build keeps review group switching code');
assert(publicHtml.includes('bulkSelectedPostPublishReviewAction'), 'public build keeps bulk review actions');
assert(publicHtml.includes('renderPostPublishMoreActions'), 'public build keeps more actions UI');

const privateIssues = scanPublicHtml(privateSource, { sourceHtml: privateSource });
assert(privateIssues.some((issue) => issue.type === 'private-account-value'), 'scan catches private account values');
assert(privateIssues.some((issue) => issue.type === 'recovery-snapshot'), 'scan catches non-empty recovery snapshots');

const publicIssues = scanPublicHtml(publicHtml, { sourceHtml: privateSource });
assert.deepStrictEqual(publicIssues, [], 'sanitized public HTML has no release-blocking issues');

console.log('public release sanitizer tests passed');
