import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual page callback without needing to mount the media/WASM UI.
const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const script = page.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('page.ts', script, ts.ScriptTarget.Latest, true);
const statements = ast.statements.filter(
	(node) =>
		(ts.isFunctionDeclaration(node) && node.name?.text === 'abandonInjectorWork') ||
		(ts.isExpressionStatement(node) &&
			ts.isCallExpression(node.expression) &&
			node.expression.expression.getText(ast) === 'beforeNavigate')
);
assert.equal(statements.length, 2, 'Locate the cleanup function and navigation callback');
const guard = ts.transpileModule(statements.map((node) => node.getText(ast)).join('\n'), {
	compilerOptions: { target: ts.ScriptTarget.ESNext }
}).outputText;

function harness({ hasUpload = true, generating = false, accept = true } = {}) {
	let callback;
	const calls = { confirm: 0, abort: 0, preview: 0, sourcePreview: 0, cancel: 0 };
	const context = {
		pageActive: true,
		hasUpload,
		generating,
		generateAbort: { abort: () => calls.abort++ },
		stopPreview: () => calls.preview++,
		stopSourcePreview: () => calls.sourcePreview++,
		confirm: () => {
			calls.confirm++;
			return accept;
		},
		beforeNavigate: (fn) => (callback = fn)
	};
	vm.runInNewContext(guard, context);
	return {
		context,
		calls,
		navigate: (overrides = {}) =>
			callback({
				willUnload: false,
				from: { route: { id: '/' }, url: new URL('https://example.com/?source=a') },
				to: {
					route: { id: '/recording-help' },
					url: new URL('https://example.com/recording-help')
				},
				complete: Promise.resolve(),
				cancel: () => calls.cancel++,
				...overrides
			})
	};
}

test('same-route query navigation keeps uploads and generation active without prompting', async () => {
	const { context, calls, navigate } = harness({ generating: true });
	navigate({ to: { route: { id: '/' }, url: new URL('https://example.com/?source=b') } });
	await Promise.resolve();
	assert.equal(context.pageActive, true);
	assert.notEqual(context.generateAbort, null);
	assert.deepEqual(calls, { confirm: 0, abort: 0, preview: 0, sourcePreview: 0, cancel: 0 });
});

test('empty injector can open help without prompting', () => {
	const { context, calls, navigate } = harness({ hasUpload: false });
	navigate();
	assert.equal(context.pageActive, true);
	assert.equal(calls.confirm, 0);
});

test('cancelling the help navigation preserves in-progress work', () => {
	const { context, calls, navigate } = harness({ accept: false });
	navigate();
	assert.equal(context.pageActive, true);
	assert.deepEqual(calls, { confirm: 1, abort: 0, preview: 0, sourcePreview: 0, cancel: 1 });
});

test('accepting the help navigation aborts work and stops both previews', () => {
	const { context, calls, navigate } = harness();
	navigate();
	assert.equal(context.pageActive, false);
	assert.equal(context.generateAbort, null);
	assert.deepEqual(calls, { confirm: 1, abort: 1, preview: 1, sourcePreview: 1, cancel: 0 });
});

test('a failed navigation reactivates the injector', async () => {
	const { context, navigate } = harness();
	navigate({ complete: Promise.reject(new Error('Navigation failed')) });
	await Promise.resolve();
	assert.equal(context.pageActive, true);
});

test('document unload leaves confirmation to the native beforeunload handler', () => {
	const { context, calls, navigate } = harness();
	navigate({ willUnload: true, to: null });
	assert.equal(context.pageActive, true);
	assert.equal(calls.confirm, 0);
	assert.equal(calls.abort, 0);
});
