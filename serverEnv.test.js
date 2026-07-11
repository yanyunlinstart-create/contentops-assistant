const assert = require('assert');
const fs = require('fs');

const server = fs.readFileSync('server.js', 'utf8');

const loadIndex = server.indexOf('loadDotEnv();');
const timeoutIndex = server.indexOf('const REQUEST_TIMEOUT_MS');
const portIndex = server.indexOf('const PORT');

assert(loadIndex > 0, 'loadDotEnv should be called at startup');
assert(timeoutIndex > 0, 'REQUEST_TIMEOUT_MS should be defined');
assert(portIndex > 0, 'PORT should be defined');
assert(loadIndex < timeoutIndex, 'dotenv should load before FEISHU_REQUEST_TIMEOUT_MS is read');
assert(loadIndex < portIndex, 'dotenv should load before PORT is read');
assert(server.includes('nodeVersion: process.version'), 'health payload should expose node version');
assert(server.includes('requestTimeoutMs: REQUEST_TIMEOUT_MS'), 'health payload should expose Feishu request timeout');
assert(server.includes('localServerRequestTimeoutMs: server.requestTimeout'), 'health payload should expose local server request timeout');
assert(!/err\.details\s*=\s*\{[\s\S]*?\n\s*url,\s*\n/.test(server), 'network error details should not expose raw Feishu URL');
assert(server.includes('url: redactFeishuUrl(url)'), 'network error details should expose only redacted Feishu URL');

console.log('server env tests passed');
