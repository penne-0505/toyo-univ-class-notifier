/**
 * 定期ジョブの失敗検知（scripts/lib/toyo-health.ts の pickErrorLines）と、
 * 通知に載せる文字列の伏せ字（scripts/lib/toyo-notify.ts の redactSensitive / scrubForPublic）の検査。
 * journal の文面は systemd / Node / Playwright が出す形式を模した合成データ。
 * Usage: npx tsx --test scripts/dev/parsers/health.test.ts
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { pickErrorLines } from '../../lib/toyo-health';
import { redactSensitive, scrubForPublic } from '../../lib/toyo-notify';

describe('pickErrorLines', () => {
  it('エラーらしき行の最後の 3 行を " / " でつなぐ', () => {
    const journal = [
      '[watch] start',
      'Error: first problem',
      'TimeoutError: page.goto: Timeout 60000ms exceeded.',
      'Failed to collect assignments: net::ERR_CONNECTION_RESET',
      'Error: ACE session lost while opening https://example.invalid/ct/home',
      '[watch] end',
    ].join('\n');
    assert.equal(
      pickErrorLines(journal),
      'TimeoutError: page.goto: Timeout 60000ms exceeded. / Failed to collect assignments: net::ERR_CONNECTION_RESET / Error: ACE session lost while opening https://example.invalid/ct/home'
    );
  });

  it('エラー行が 3 行に満たなければあるだけ返す', () => {
    assert.equal(pickErrorLines('ok\nError: boom\nok'), 'Error: boom');
  });

  it('エラー行が無ければ null（空文字・空行だけも）', () => {
    assert.equal(pickErrorLines(''), null);
    assert.equal(pickErrorLines('\n\n  \n'), null);
    assert.equal(pickErrorLines('[sync] done\ncourses=12 assignments=11'), null);
  });

  it('error / timeout / failed / econn / exception / exceeded を大文字小文字を問わず拾う', () => {
    for (const line of ['ERROR happened', 'request timeout', 'Task Failed', 'connect ECONNREFUSED 127.0.0.1:443', 'Unhandled Exception', 'Limit exceeded']) {
      assert.equal(pickErrorLines(line), line, line);
    }
  });

  it('回帰: 成功時にも出る「0 件」系の行（failed: 0 / errors=0 / 0 errors）は拾わない', () => {
    const journal = ['[coursework] failed: 0', '[sync] errors=0', '[sync] errors: 0', '[summary] 0 errors', '[x] 0 failed'].join('\n');
    assert.equal(pickErrorLines(journal), null);
  });

  it('0 件ではない failed / errors は拾う', () => {
    assert.equal(pickErrorLines('[sync] failed: 2'), '[sync] failed: 2');
    assert.equal(pickErrorLines('[sync] errors=10'), '[sync] errors=10');
  });

  it('Node の triggerUncaughtException のスタック行は拾わない', () => {
    const journal = ['    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)', 'node:internal/process/execution:110 triggerUncaughtException(', 'Error: real cause'].join('\n');
    assert.equal(pickErrorLines(journal), 'Error: real cause');
  });

  it('systemd 自身の行（Main process exited / Failed to start）は原因の手掛かりにならないので拾わない', () => {
    const journal = [
      'toyo-watch.service: Main process exited, code=exited, status=1/FAILURE',
      'toyo-watch.service: Failed with result \'exit-code\'.',
      'Failed to start toyo-watch.service - Toyo watch.',
      'Error: real cause',
    ].join('\n');
    assert.equal(pickErrorLines(journal), 'Error: real cause');
  });

  it('CRLF 区切りと行頭・行末の空白を許す', () => {
    assert.equal(pickErrorLines('ok\r\n   Error: boom   \r\nok\r\n'), 'Error: boom');
  });
});

describe('redactSensitive / scrubForPublic', () => {
  const saved = { user: process.env.TOYO_USERNAME, pass: process.env.TOYO_PASSWORD };
  afterEach(() => {
    for (const [name, value] of [['TOYO_USERNAME', saved.user], ['TOYO_PASSWORD', saved.pass]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('環境変数のユーザー名・パスワードを *** にする（4 文字未満は伏せない）', () => {
    process.env.TOYO_USERNAME = 'dummy-user-0001';
    process.env.TOYO_PASSWORD = 'abc';
    assert.equal(redactSensitive('login failed for dummy-user-0001 with abc'), 'login failed for *** with abc');
  });

  it('Bearer トークンと 10 桁の数字（学籍番号など）を伏せる。10 桁を超える数字列の一部は伏せない', () => {
    delete process.env.TOYO_USERNAME;
    delete process.env.TOYO_PASSWORD;
    assert.equal(redactSensitive('Authorization: Bearer abcDEF123_-xyz failed'), 'Authorization: Bearer *** failed');
    assert.equal(redactSensitive('student 9999999999 not found'), 'student ********** not found');
    assert.equal(redactSensitive('id 12345678901 ok'), 'id 12345678901 ok');
  });

  it('公開サーバー向けは URL と 32 文字以上のトークン様の文字列も落とす', () => {
    delete process.env.TOYO_USERNAME;
    delete process.env.TOYO_PASSWORD;
    assert.equal(scrubForPublic('GET https://example.invalid/v1/context failed'), 'GET <url> failed');
    assert.equal(scrubForPublic(`key ${'a'.repeat(44)} rejected`), 'key *** rejected');
  });
});
