import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const source = readFileSync('dashboard/server.js', 'utf8');
const start = source.indexOf('const requestJson =');
const code = source.slice(start, source.indexOf('\nconst proxmoxRequestOptions', start));

function requestWithResponse(statusMessage, body) {
  const transport = {
    request(_target, _options, callback) {
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter();
        Object.assign(response, { statusCode: 596, statusMessage, setEncoding() {} });
        callback(response);
        response.emit('data', body);
        response.emit('end');
      };
      return request;
    }
  };
  const context = { URL, Buffer, http: transport, https: transport };
  vm.runInNewContext(`${code}\nthis.requestJson = requestJson;`, context);
  return context.requestJson({ url: 'https://proxmox.example/api2/json/nodes' });
}

test('empty Proxmox errors preserve the HTTP reason phrase', async () => {
  await assert.rejects(requestWithResponse('Connection timed out', ''), error => {
    assert.equal(error.message, 'HTTP 596: Connection timed out');
    assert.equal(error.statusCode, 596);
    assert.equal(error.statusMessage, 'Connection timed out');
    assert.equal(error.responseBody, '');
    return true;
  });
});

test('response body remains the preferred error detail', async () => {
  await assert.rejects(requestWithResponse('Error', 'storage unavailable'), /HTTP 596: storage unavailable/);
});

test('missing error details have an explicit fallback', async () => {
  await assert.rejects(requestWithResponse('', '  '), /HTTP 596: Empty error response/);
});
