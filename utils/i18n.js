/**
 * i18n - 中文/English 双语支持
 */
const TRANSLATIONS = {
    zh: {
        'tab.collect': '收集', 'tab.publish': '发布', 'tab.resources': '资源库', 'tab.logs': '日志',
        'collect.targetDomain': '目标域名', 'collect.myDomain': '我的域名',
        'collect.domainPlaceholder': '例如 competitor.com',
        'collect.myDomainPlaceholder': '例如 mysite.com',
        'collect.start': '开始收集', 'collect.stop': '停止收集',
        'collect.analyzing': '正在分析外链页面...',
        'collect.idle': '等待开始...', 'collect.done': '收集完成',
        'collect.backlinksFound': '已发现外链', 'collect.analyzed': '已分析',
        'collect.blogResources': '博客评论资源', 'collect.inQueue': '队列中',
        'collect.source': '数据源',
        'publish.title': '评论发布', 'publish.tasks': '发布任务', 'publish.start': '开始发布', 'publish.stop': '停止发布',
        'publish.semiAuto': '半自动', 'publish.fullAuto': '全自动',
        'publish.pending': '待发布', 'publish.published': '已发布',
        'publish.skipped': '已跳过', 'publish.failed': '失败',
        'publish.noResources': '暂无可发布资源，请先收集外链',
        'publish.current': '当前发布', 'publish.progress': '进度',
        'resources.title': '资源库', 'resources.url': '网址',
        'resources.source': '来源', 'resources.type': '类型',
        'resources.status': '状态', 'resources.time': '发现时间',
        'resources.delete': '删除', 'resources.export': '导出',
        'resources.empty': '暂无资源数据', 'resources.total': '总计',
        'resources.items': '条',
        'status.pending': '待发布', 'status.published': '已发布',
        'status.skipped': '已跳过', 'status.failed': '失败',
        'settings.title': '设置', 'settings.userInfo': '用户信息',
        'settings.name': '名称', 'settings.email': '邮箱',
        'settings.website': '网站 URL',
        'settings.apiKey': 'OpenAI API Key',
        'settings.apiKeyPlaceholder': 'sk-...',
        'settings.templates': '评论模板',
        'settings.templatePlaceholder': '支持变量：{title}、{domain}、{keyword}',
        'settings.addTemplate': '添加模板', 'settings.removeTemplate': '删除',
        'settings.anchor': '锚文本设置',
        'settings.anchorKeyword': '关键词', 'settings.anchorUrl': '目标 URL',
        'settings.mode': '发布模式', 'settings.save': '保存设置',
        'settings.saved': '✓ 已保存', 'settings.back': '← 返回',
        'footer.settings': '设置', 'footer.clear': '清空数据',
        'footer.clearConfirm': '确定要清空所有数据？此操作不可撤销！',
        'dialog.title': 'Comment Ready',
        'dialog.message': '评论表单已填充完毕。请检查内容后点击 Submit 提交，或 Skip 跳过。',
        'dialog.submit': 'Submit', 'dialog.skip': 'Skip',
    },
    en: {
        'tab.collect': 'Collect', 'tab.publish': 'Publish', 'tab.resources': 'Resources', 'tab.logs': 'Logs',
        'collect.targetDomain': 'Target Domain', 'collect.myDomain': 'My Domain',
        'collect.domainPlaceholder': 'e.g. competitor.com',
        'collect.myDomainPlaceholder': 'e.g. mysite.com',
        'collect.start': 'Start', 'collect.stop': 'Stop',
        'collect.analyzing': 'Analyzing backlink pages...',
        'collect.idle': 'Waiting to start...', 'collect.done': 'Collection complete',
        'collect.backlinksFound': 'Backlinks', 'collect.analyzed': 'Analyzed',
        'collect.blogResources': 'Blog Resources', 'collect.inQueue': 'In Queue',
        'collect.source': 'Source',
        'publish.title': 'Publish', 'publish.tasks': 'Publish Tasks', 'publish.start': 'Start', 'publish.stop': 'Stop',
        'publish.semiAuto': 'Semi-auto', 'publish.fullAuto': 'Full Auto',
        'publish.pending': 'Pending', 'publish.published': 'Published',
        'publish.skipped': 'Skipped', 'publish.failed': 'Failed',
        'publish.noResources': 'No resources. Please collect backlinks first.',
        'publish.current': 'Current', 'publish.progress': 'Progress',
        'resources.title': 'Resources', 'resources.url': 'URL',
        'resources.source': 'Source', 'resources.type': 'Type',
        'resources.status': 'Status', 'resources.time': 'Time',
        'resources.delete': 'Delete', 'resources.export': 'Export',
        'resources.empty': 'No resources found', 'resources.total': 'Total',
        'resources.items': 'items',
        'status.pending': 'Pending', 'status.published': 'Published',
        'status.skipped': 'Skipped', 'status.failed': 'Failed',
        'settings.title': 'Settings', 'settings.userInfo': 'User Info',
        'settings.name': 'Name', 'settings.email': 'Email',
        'settings.website': 'Website URL',
        'settings.apiKey': 'OpenAI API Key',
        'settings.apiKeyPlaceholder': 'sk-...',
        'settings.templates': 'Comment Templates',
        'settings.templatePlaceholder': 'Variables: {title}, {domain}, {keyword}',
        'settings.addTemplate': 'Add Template', 'settings.removeTemplate': 'Remove',
        'settings.anchor': 'Anchor Text',
        'settings.anchorKeyword': 'Keyword', 'settings.anchorUrl': 'Target URL',
        'settings.mode': 'Publish Mode', 'settings.save': 'Save',
        'settings.saved': '✓ Saved', 'settings.back': '← Back',
        'footer.settings': 'Settings', 'footer.clear': 'Clear Data',
        'footer.clearConfirm': 'Clear all data? This cannot be undone!',
        'dialog.title': 'Comment Ready',
        'dialog.message': 'The comment form has been filled. Review and click Submit or Skip.',
        'dialog.submit': 'Submit', 'dialog.skip': 'Skip',
    }
};

let currentLang = 'zh';

function setLanguage(lang) {
    currentLang = lang;
    chrome.storage.local.set({ language: lang });
}

function t(key) {
    return TRANSLATIONS[currentLang]?.[key] || TRANSLATIONS['zh'][key] || key;
}

async function loadLanguage() {
    const result = await chrome.storage.local.get('language');
    currentLang = result.language || 'zh';
    return currentLang;
}

if (typeof window !== 'undefined') {
    window.i18n = { t, setLanguage, loadLanguage, TRANSLATIONS, get currentLang() { return currentLang; } };
}
