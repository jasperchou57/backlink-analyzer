/**
 * Workflow Registry - 内置工作流定义
 * 第一版先使用 JS 对象配置，后续可以外置成 JSON/YAML。
 */

const BUILTIN_WORKFLOWS = [
    {
        id: 'blog-comment-backlink',
        name: 'Blog Comment Backlink',
        description: '发现博客评论机会并自动/半自动完成评论表单填写与发布。',
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

    supportsResource(workflow, resource) {
        if (!workflow) return false;
        const supported = new Set(workflow.supportedOpportunities || []);
        if (supported.size === 0) return true;

        const resourceTypes = new Set(resource?.opportunities || []);
        const fallbackTypes = String(resource?.type || '')
            .split('+')
            .map(item => item.trim())
            .filter(Boolean);
        fallbackTypes.forEach(type => resourceTypes.add(type));

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
