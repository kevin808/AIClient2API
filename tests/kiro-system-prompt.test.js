jest.mock('../src/utils/common.js', () => ({
    MODEL_PROVIDER: { KIRO_API: 'claude-kiro-oauth' }
}));
jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));
jest.mock('../src/providers/provider-models.js', () => ({
    getProviderModels: () => ['claude-sonnet-4-5', 'claude-sonnet-4-6']
}));
jest.mock('../src/utils/proxy-utils.js', () => ({}));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import { KiroApiService } from '../src/providers/claude/claude-kiro.js';

const emptySystems = [
    ['omitted', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace', ' \n\t '],
    ['empty blocks', []],
    ['empty text block', [{ type: 'text', text: '' }]],
    ['blank text block', [{ type: 'text', text: ' \n ' }]],
    ['empty content', { content: [] }]
];
const thinkingModes = [
    ['omitted', null],
    ['enabled', { type: 'enabled', budget_tokens: 2048 }],
    ['adaptive', { type: 'adaptive', effort: 'high' }]
];
const conversations = [
    ['single turn', [{ role: 'user', content: 'Question' }]],
    ['multiple turns', [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
        { role: 'user', content: 'Question' }
    ]],
    ['assistant first', [
        { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
        { role: 'user', content: 'Question' }
    ]]
];

async function build(messages, system, thinking, model = 'claude-sonnet-4-5') {
    // Bypass credential loading; exercise the real request builder without network calls.
    const service = Object.create(KiroApiService.prototype);
    service.config = {};
    return service.buildCodewhispererRequest(structuredClone(messages), model, null, system, thinking);
}

function userTexts(request) {
    const state = request.conversationState;
    return [...(state.history || []), state.currentMessage]
        .filter(message => message.userInputMessage)
        .map(message => message.userInputMessage.content);
}

describe.each(conversations)('Kiro system injection: %s', (_label, messages) => {
    test.each(emptySystems.flatMap(([name, system]) => thinkingModes.map(([mode, thinking]) =>
        [`${name}, thinking ${mode}`, system, thinking]
    )))('does not inject prompt text for %s', async (_case, system, thinking) => {
        const request = await build(messages, system, thinking);
        const expected = messages.filter(message => message.role === 'user').map(message => message.content);
        expect(userTexts(request)).toEqual(expected);
        expect(request.conversationState.history || []).toHaveLength(messages.length - 1);
        expect(JSON.stringify(request)).not.toMatch(/CRITICAL_OVERRIDE|<identity>|tool_use_guidelines|<thinking_mode>|<max_thinking_length>|<thinking_effort>/);
    });

    test.each(thinkingModes)('preserves explicit system text with thinking %s', async (_mode, thinking) => {
        const request = await build(messages, 'Explicit system instructions', thinking);
        const texts = userTexts(request).join('\n');
        expect(texts).toContain('Explicit system instructions');
        expect(texts.match(/<CRITICAL_OVERRIDE>/g)).toHaveLength(1);
        expect(texts.match(/Explicit system instructions/g)).toHaveLength(1);
        if (thinking) {
            expect(texts.match(/<thinking_mode>/g)).toHaveLength(1);
            expect(texts).toContain(`<thinking_mode>${thinking.type}</thinking_mode>`);
        } else {
            expect(texts).not.toContain('<thinking_mode>');
        }
    });
});

test('preserves nonempty Anthropic system blocks', async () => {
    const request = await build(conversations[0][1], [{ type: 'text', text: 'Block instructions' }], null);
    expect(userTexts(request)[0]).toContain('Block instructions');
});

test('does not duplicate a thinking prefix already supplied in system text', async () => {
    const request = await build(conversations[0][1], '<thinking_mode>enabled</thinking_mode>\nExplicit instructions', thinkingModes[1][1]);
    expect(userTexts(request)[0].match(/<thinking_mode>/g)).toHaveLength(1);
});

test('preserves historical assistant thinking without adding prompt prefixes', async () => {
    const request = await build([
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Past reasoning' }, { type: 'text', text: 'Answer' }] },
        { role: 'user', content: 'Question' }
    ], null, thinkingModes[1][1]);
    expect(userTexts(request)).toEqual(['First question', 'Question']);
    expect(request.conversationState.history[1].assistantResponseMessage.content).toContain('Past reasoning');
});

test('preserves explicit native reasoning parameters when system is absent', async () => {
    const request = await build(conversations[0][1], null, thinkingModes[1][1], 'claude-sonnet-4-6');
    expect(userTexts(request)).toEqual(['Question']);
    expect(request.additionalModelRequestFields).toEqual({ output_config: { effort: 'medium' } });
});
