import {readFile} from 'node:fs/promises';

const paths = process.argv.slice(2);
for (const path of paths) {
	const profile = JSON.parse(await readFile(path, 'utf8'));
	const nodes = new Map(profile.nodes.map(node => [node.id, node]));
	const totals = new Map();
	let sampled = 0;
	for (let i = 0; i < profile.samples.length; i++) {
		const duration = profile.timeDeltas[i] ?? 0;
		const node = nodes.get(profile.samples[i]);
		if (!node) continue;
		sampled += duration;
		const frame = node.callFrame;
		const key = `${frame.functionName || '(anonymous)'}\t${frame.url || '(native)'}:${(frame.lineNumber ?? -1) + 1}`;
		totals.set(key, (totals.get(key) ?? 0) + duration);
	}
	console.log(`\n${path}\t${(sampled / 1e6).toFixed(3)} sampled seconds`);
	for (const [key, duration] of [...totals].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
		console.log(`${(duration / 1e6).toFixed(3)}s\t${(duration / sampled * 100).toFixed(1)}%\t${key}`);
	}

	const parentByID = new Map();
	for (const node of profile.nodes) {
		for (const child of node.children ?? []) parentByID.set(child, node.id);
	}
	const inclusive = new Map();
	for (let i = 0; i < profile.samples.length; i++) {
		const duration = profile.timeDeltas[i] ?? 0;
		let id = profile.samples[i];
		const seen = new Set();
		while (id !== undefined) {
			const node = nodes.get(id);
			if (!node) break;
			const frame = node.callFrame;
			const key = `${frame.functionName || '(anonymous)'}\t${frame.url || '(native)'}:${(frame.lineNumber ?? -1) + 1}`;
			if (!seen.has(key)) inclusive.set(key, (inclusive.get(key) ?? 0) + duration);
			seen.add(key);
			id = parentByID.get(id);
		}
	}
	console.log('inclusive:');
	for (const [key, duration] of [...inclusive]
		.filter(([key]) => !key.startsWith('(root)') && !key.startsWith('(idle)'))
		.sort((a, b) => b[1] - a[1])
		.slice(0, 40)) {
		console.log(`${(duration / 1e6).toFixed(3)}s\t${(duration / sampled * 100).toFixed(1)}%\t${key}`);
	}
}
