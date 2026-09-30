'use strict';
const assert = require('assert');
const { buildCommonParams } = require('../server/server');

const star = buildCommonParams({ model: 'gpt-image-2', prompt: 'test', size: '1024*1536' }, {});
assert.strictEqual(star.size, '1024x1536');

const spaced = buildCommonParams({ model: 'gpt-image-2', prompt: 'test', size: ' 1280 * 720 ' }, {});
assert.strictEqual(spaced.size, '1280x720');

console.log('尺寸星号分隔符兼容测试通过');
