import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseUnifiedDiff, viewDocument, viewPolicy } from '../src/lib/codeViews.ts';

const GIT_DIFF = `diff --git a/src/login.test.ts b/src/login.test.ts
index 3b18e51..a9c2f04 100644
--- a/src/login.test.ts
+++ b/src/login.test.ts
@@ -1,4 +1,4 @@
 import { login } from './login';
-it('logs in', flaky);
+it('logs in', stable);

 export {};
diff --git a/README.md b/docs/README.md
similarity index 90%
rename from README.md
rename to docs/README.md
--- a/README.md
+++ b/docs/README.md
@@ -3 +3,2 @@
--- old rule
+--- new rule
+and another line
\\ No newline at end of file
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;

describe('parseUnifiedDiff', () => {
  test('files, line kinds, numbers and counts from git diff output', () => {
    const files = parseUnifiedDiff(GIT_DIFF);
    assert.deepEqual(
      files.map((file) => [file.name, file.from, file.added, file.removed, file.binary]),
      [
        ['src/login.test.ts', undefined, 1, 1, false],
        ['docs/README.md', 'README.md', 2, 1, false],
        ['logo.png', undefined, 0, 0, true],
      ],
    );
    const [login, readme] = files;
    assert.deepEqual(login!.lines.map((line) => line.kind), ['hunk', 'context', 'del', 'add', 'context', 'context']);
    assert.deepEqual([login!.lines[2]!.old, login!.lines[3]!.new, login!.lines[5]!.old, login!.lines[5]!.new], [2, 2, 4, 4]);
    assert.equal(login!.lines[4]!.text, ' ', 'an empty context line');
    // A removed line that starts with "--" is still a removed line inside its hunk.
    assert.deepEqual(readme!.lines.map((line) => [line.kind, line.text]), [
      ['hunk', '@@ -3 +3,2 @@'],
      ['del', '--- old rule'],
      ['add', '+--- new rule'],
      ['add', '+and another line'],
      ['note', '\\ No newline at end of file'],
    ]);
  });

  test('plain patches without git headers, new files', () => {
    const files = parseUnifiedDiff('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n--- a/old.txt\n+++ b/old.txt\n@@ -1 +1 @@\n-a\n+b\n');
    assert.deepEqual(files.map((file) => [file.name, file.added, file.removed]), [['new.txt', 1, 0], ['old.txt', 1, 1]]);
  });

  test('nothing that looks like a diff gives no files', () => {
    assert.deepEqual(parseUnifiedDiff('just some text'), []);
  });
});

describe('view frames', () => {
  test('the policy allows only the declared origins, never connections, frames or forms', () => {
    const policy = viewPolicy(['https://cdn.example.com', 'javascript:alert(1)', 'https://fonts.example.com:8443']);
    assert.match(policy, /^default-src 'none'; script-src 'unsafe-inline' https:\/\/cdn\.example\.com https:\/\/fonts\.example\.com:8443;/);
    assert.ok(!policy.includes('javascript:'));
    assert.match(policy, /connect-src 'none'/);
    assert.match(policy, /frame-src 'none'/);
    assert.match(policy, /form-action 'none'/);
    assert.equal(viewPolicy([]).includes('https:'), false);
  });

  test('the policy comes before anything the agent wrote', () => {
    const html = viewDocument('<!doctype html><html><head><script>alert(1)</script></head><body>hi</body></html>', []);
    assert.ok(html.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'`));
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script>'));
  });
});
