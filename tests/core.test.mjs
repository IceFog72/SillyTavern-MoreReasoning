import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildPromptInjection,
    extractReasoningBlocks,
    getActiveParsers,
    getParserValidationError,
    mergeReasoningBlocks,
    normalizeSettings,
    selectPromptBlocks,
} from '../core.js';

const parsers = [
    {
        id: 'think', name: 'Thought', prefix: '<think>', suffix: '</think>', separator: '\n\n',
        maxAdditions: 0, enabled: true, autoExpand: false, addToPrompts: true, showHidden: true,
    },
    {
        id: 'plan', name: 'Plan', prefix: '<plan>', suffix: '</plan>', separator: '\n\n',
        maxAdditions: 2, enabled: true, autoExpand: false, addToPrompts: true, showHidden: true,
    },
    {
        id: 'reflect', name: 'Reflection', prefix: '<reflection>', suffix: '</reflection>', separator: '\n',
        maxAdditions: 1, enabled: true, autoExpand: false, addToPrompts: true, showHidden: true,
    },
];

test('normalization preserves existing legacy-looking IDs and partial parsers', () => {
    const settings = normalizeSettings({
        parsers: [{ id: 'parser_123_random', name: 'X', prefix: '<x>', suffix: '' }],
    });
    assert.equal(settings.parsers[0].id, 'parser_123_random');
    assert.equal(settings.parsers[0].prefix, '<x>');
    assert.equal(settings.parsers[0].suffix, '');
});

test('validation rejects duplicate and overlapping prefixes without deleting settings', () => {
    const duplicate = [
        { ...parsers[1], id: 'a', prefix: '<plan>' },
        { ...parsers[2], id: 'b', prefix: '<plan>' },
    ];
    assert.match(getParserValidationError(duplicate[0], duplicate), /duplicate/i);

    const overlap = [
        { ...parsers[1], id: 'a', prefix: '<plan' },
        { ...parsers[2], id: 'b', prefix: '<plan>' },
    ];
    assert.match(getParserValidationError(overlap[0], overlap), /overlap/i);
    assert.equal(getActiveParsers(overlap).length, 0);
});

test('extracts multiple parsers and removes their raw tags from visible content', () => {
    const result = extractReasoningBlocks(
        '<plan>first</plan>Visible<reflection>second</reflection> end',
        parsers,
        value => `EXP:${value}`,
    );
    assert.equal(result.cleanedText, 'Visible end');
    assert.deepEqual(result.blocks.map(block => [block.parserId, block.content]), [
        ['plan', 'first'],
        ['reflect', 'second'],
    ]);
    assert.equal(result.blocks[0].expandedContent, 'EXP:first');
});

test('keeps nested different-parser tags inside the outer block', () => {
    const result = extractReasoningBlocks(
        '<plan>outer <reflection>inner</reflection> tail</plan>answer',
        parsers,
    );
    assert.equal(result.cleanedText, 'answer');
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].parserId, 'plan');
    assert.equal(result.blocks[0].content, 'outer <reflection>inner</reflection> tail');
});

test('supports nested instances of the same parser', () => {
    const result = extractReasoningBlocks('<plan>a<plan>b</plan>c</plan>x', parsers);
    assert.equal(result.cleanedText, 'x');
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].content, 'a<plan>b</plan>c');
});

test('marks streaming blocks incomplete when suffix is absent', () => {
    const result = extractReasoningBlocks('hello<plan>still working', parsers);
    assert.equal(result.cleanedText, 'hello');
    assert.equal(result.blocks[0].content, 'still working');
    assert.equal(result.blocks[0].incomplete, true);
});

test('merge replaces only parser families present in newly parsed text', () => {
    const existing = [
        { parserId: 'think', content: 'old thought' },
        { parserId: 'plan', content: 'old plan' },
    ];
    const parsed = [{ parserId: 'plan', content: 'new plan' }];
    const merged = mergeReasoningBlocks(existing, parsed, new Set(['plan']));
    assert.deepEqual(merged.map(block => block.content), ['old thought', 'new plan']);
});

test('prompt selection uses exact prompt chat and selects newest N blocks globally', () => {
    const promptChat = [
        { mes: 'm0', extra: { reasoning_blocks: [{ parserId: 'plan', content: 'oldest' }] } },
        { mes: 'm1', extra: { reasoning_blocks: [
            { parserId: 'plan', content: 'middle-a' },
            { parserId: 'plan', content: 'middle-b' },
        ] } },
        { mes: 'm2', extra: { reasoning_blocks: [{ parserId: 'plan', content: 'newest' }] } },
    ];
    const selected = selectPromptBlocks(promptChat, parsers);
    assert.deepEqual([...selected].sort(), ['1:1', '2:0']);
});

test('prompt selection naturally handles swipe-like chat with current message already removed', () => {
    const promptChat = [
        { mes: 'a', extra: { reasoning_blocks: [{ parserId: 'plan', content: 'A' }] } },
        { mes: 'b', extra: { reasoning_blocks: [{ parserId: 'plan', content: 'B' }] } },
    ];
    const selected = selectPromptBlocks(promptChat, [{ ...parsers[1], maxAdditions: 1 }]);
    assert.deepEqual([...selected], ['1:0']);
});

test('system/tool messages can be skipped without shifting block-to-message association', () => {
    const promptChat = [
        { mes: 'assistant-a', extra: { reasoning_blocks: [{ parserId: 'plan', content: 'A' }] } },
        { mes: 'tool', is_system: true, extra: { reasoning_blocks: [{ parserId: 'plan', content: 'WRONG' }] } },
        { mes: 'assistant-b', extra: { reasoning_blocks: [{ parserId: 'plan', content: 'B' }] } },
    ];
    const selected = selectPromptBlocks(
        promptChat,
        [{ ...parsers[1], maxAdditions: 2 }],
        item => Boolean(item.is_system),
    );
    assert.deepEqual([...selected].sort(), ['0:0', '2:0']);
});

test('buildPromptInjection preserves source order for multiple selected blocks in one message', () => {
    const item = {
        extra: {
            reasoning_blocks: [
                { parserId: 'plan', content: 'older', expandedContent: 'OLDER' },
                { parserId: 'plan', content: 'newer', expandedContent: 'NEWER' },
            ],
        },
    };
    const selected = new Set(['0:0', '0:1']);
    const injection = buildPromptInjection(item, 0, selected, parsers, value => value, { lastMessageIndex: 0 });
    assert.equal(injection, '<plan>OLDER</plan>\n\n<plan>NEWER</plan>\n\n');
});

test('active incomplete continue block is injected without an artificial suffix', () => {
    const item = {
        extra: { reasoning_blocks: [{ parserId: 'plan', content: 'unfinished', incomplete: true }] },
    };
    const selected = new Set(['0:0']);
    const injection = buildPromptInjection(
        item,
        0,
        selected,
        parsers,
        value => value,
        { type: 'continue', lastMessageIndex: 0 },
    );
    assert.equal(injection, '<plan>unfinished');
});


test('Max 1 picks the newest block even when two blocks are in the same message', () => {
    const promptChat = [{
        mes: 'm',
        extra: { reasoning_blocks: [
            { parserId: 'plan', content: 'old' },
            { parserId: 'plan', content: 'new' },
        ] },
    }];
    const selected = selectPromptBlocks(promptChat, [{ ...parsers[1], maxAdditions: 1 }]);
    assert.deepEqual([...selected], ['0:1']);
});

test('Add to Prompts false excludes a parser even when Max is positive', () => {
    const promptChat = [{
        mes: 'm',
        extra: { reasoning_blocks: [{ parserId: 'plan', content: 'secret' }] },
    }];
    const selected = selectPromptBlocks(promptChat, [{ ...parsers[1], addToPrompts: false, maxAdditions: 10 }]);
    assert.equal(selected.size, 0);
});

test('an incomplete historical block is closed, while only active continue stays open', () => {
    const item = { extra: { reasoning_blocks: [{ parserId: 'plan', content: 'unfinished', incomplete: true }] } };
    const selected = new Set(['0:0']);
    const historical = buildPromptInjection(item, 0, selected, parsers, value => value, { type: 'normal', lastMessageIndex: 0 });
    assert.equal(historical, '<plan>unfinished</plan>\n\n');
});

test('missing suffix keeps parser persisted but inactive', () => {
    const incomplete = [{ ...parsers[1], suffix: '' }];
    assert.match(getParserValidationError(incomplete[0], incomplete), /suffix/i);
    assert.equal(getActiveParsers(incomplete).length, 0);
});
