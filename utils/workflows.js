/**
 * Workflow Registry - 内置工作流定义
 * 第一版先使用 JS 对象配置，后续可以外置成 JSON/YAML。
 */

const BUILTIN_WORKFLOWS = [
    {
        id: 'blog-comment-backlink',
        name: '直发外链',
        description: '发现当前页面即可免登录/免注册直接提交外链的网页，并自动/半自动完成表单填写与发布。',
        category: 'publish',
        taskType: 'publish',
        executor: 'comment-publisher',
        scripts: ['content/comment-publisher.js'],
        styles: ['content/comment-publisher.css'],
        supportedOpportunities: ['comment'],
        defaults: {
            useAI: true
        },
        steps: [
            { id: 'find_form', action: 'findForm', useAI: true },
            { id: 'generate_comment', action: 'generateComment', useAI: true },
            { id: 'fill_primary_fields', action: 'fillFields', fields: ['comment', 'name', 'email', 'website'] },
            { id: 'solve_captcha', action: 'solveCaptcha' },
            { id: 'check_antispam', action: 'checkAntiSpam' },
            { id: 'clear_notifications', action: 'uncheckNotifications' },
            { id: 'finalize', action: 'reviewOrSubmit' }
        ]
    },
    {
        id: 'product-promote-campaign',
        name: '产品宣传',
        description: '围绕你的产品自动做渠道调研、生成宣传计划、推荐社区发帖和目录提交入口，并把长期养号任务拆出去。',
        category: 'promote',
        taskType: 'promote',
        executor: 'browser-agent',
        scripts: [],
        styles: [],
        supportedOpportunities: [],
        defaults: {
            targetAudience: '',
            preferredChannels: '',
            campaignBrief: ''
        },
        steps: [
            { id: 'research_target', action: 'researchTarget' },
            { id: 'build_campaign_plan', action: 'buildCampaignPlan' },
            { id: 'dispatch_channel', action: 'dispatchChannel' }
        ]
    },
    {
        id: 'community-post-promote',
        name: '社区发帖子步骤',
        description: '面向 Reddit、论坛、社群、帖子广场的发帖推广任务。先定义平台、文案角度和落地页。',
        category: 'promote',
        taskType: 'promote',
        internal: true,
        executor: 'browser-agent',
        scripts: [],
        styles: [],
        supportedOpportunities: [],
        defaults: {
            platformUrl: '',
            campaignBrief: '',
            postAngle: ''
        },
        steps: [
            { id: 'research_platform', action: 'researchPlatform' },
            { id: 'draft_post', action: 'draftPost' },
            { id: 'open_platform', action: 'openPlatform' },
            { id: 'post_or_wait_human', action: 'postOrWaitHuman' }
        ]
    },
    {
        id: 'directory-submit-promote',
        name: '目录提交子步骤',
        description: '面向导航站、目录站、提交站的提交通道任务，适合产品站、工具站和小游戏站。',
        category: 'promote',
        taskType: 'promote',
        internal: true,
        executor: 'browser-agent',
        scripts: [],
        styles: [],
        supportedOpportunities: ['submit-site', 'listing', 'guest-post'],
        defaults: {
            platformUrl: '',
            campaignBrief: '',
            submitCategory: ''
        },
        steps: [
            { id: 'open_directory', action: 'openDirectory' },
            { id: 'fill_submission', action: 'fillSubmission' },
            { id: 'submit_or_wait_human', action: 'submitOrWaitHuman' }
        ]
    },
    {
        id: 'account-nurture',
        name: '账号养护',
        description: '长期养号任务。定期打开目标平台，浏览、点赞、评论、低频互动，逐步建立账号历史。',
        category: 'nurture',
        taskType: 'nurture',
        executor: 'browser-agent',
        scripts: [],
        styles: [],
        supportedOpportunities: [],
        defaults: {
            platformUrl: '',
            frequency: 'daily',
            sessionGoal: '浏览帖子并完成低频互动'
        },
        steps: [
            { id: 'open_platform', action: 'openPlatform' },
            { id: 'browse_feed', action: 'browseFeed' },
            { id: 'perform_actions', action: 'performActions' },
            { id: 'record_session', action: 'recordSession' }
        ]
    },
    {
        id: 'research-plan',
        name: '渠道调研子步骤',
        description: '先调研目标产品和推广渠道，再输出执行计划，适合作为大任务之前的第一阶段。',
        category: 'research',
        taskType: 'research',
        internal: true,
        executor: 'browser-agent',
        scripts: [],
        styles: [],
        supportedOpportunities: [],
        defaults: {
            campaignBrief: '',
            targetAudience: '',
            preferredChannels: ''
        },
        steps: [
            { id: 'research_target', action: 'researchTarget' },
            { id: 'search_channels', action: 'searchChannels' },
            { id: 'build_plan', action: 'buildPlan' }
        ]
    }
];

const WorkflowRegistry = {
    DEFAULT_WORKFLOW_ID: 'blog-comment-backlink',

    list() {
        return BUILTIN_WORKFLOWS.map(workflow => cloneWorkflow(workflow));
    },

    get(workflowId) {
        const workflow = BUILTIN_WORKFLOWS.find(item => item.id === workflowId)
            || BUILTIN_WORKFLOWS.find(item => item.id === this.DEFAULT_WORKFLOW_ID)
            || BUILTIN_WORKFLOWS[0];
        return workflow ? cloneWorkflow(workflow) : null;
    },

    getLabel(workflowId) {
        return this.get(workflowId)?.name || workflowId || '';
    },

    getMeta(workflowId) {
        return this.get(workflowId) || null;
    },

    supportsResource(workflow, resource, task = {}) {
        if (!workflow) return false;
        const supported = new Set(workflow.supportedOpportunities || []);
        if (supported.size === 0) return true;

        const resourceTypes = new Set(resource?.opportunities || []);
        const fallbackTypes = String(resource?.type || '')
            .split('+')
            .map(item => item.trim())
            .filter(Boolean);
        fallbackTypes.forEach(type => resourceTypes.add(type));

        const looksLikeNoAuthDirectPublish = !!globalThis.ResourceRules?.resourceLooksLikeNoAuthDirectPublish?.(resource);

        if (workflow.id === 'blog-comment-backlink') {
            return looksLikeNoAuthDirectPublish;
        }

        for (const type of resourceTypes) {
            if (supported.has(type)) return true;
        }
        return false;
    }
};

function cloneWorkflow(workflow) {
    return JSON.parse(JSON.stringify(workflow));
}

if (typeof self !== 'undefined') {
    self.WorkflowRegistry = WorkflowRegistry;
}

if (typeof window !== 'undefined') {
    window.WorkflowRegistry = WorkflowRegistry;
}
